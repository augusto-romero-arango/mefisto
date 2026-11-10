#!/usr/bin/env bash
# test-herdr-parallel.sh -- Tests del modo --parallel de scripts/herdr-pipeline.sh
# (issue #705: un pane apilado por issue dentro del workspace herdr actual).
#
# Dos estilos combinados:
#   - Funciones puras (estilo test-herdr-workspace.sh): se extrae SOLO el
#     cuerpo de stack_split_ratio (awk sobre "nombre() {" .. "}" en columna 0)
#     y se evalua en este proceso, sin sourcing el archivo completo.
#   - Subproceso real con stubs (estilo test-tmux-preparse.sh): un "consumidor"
#     falso (mktemp -d + git init, sin .claude-plugin/plugin.json) y stubs de
#     `herdr` y `gh` en PATH que registran cada invocacion y devuelven
#     respuestas deterministas -- nunca tocan un servidor herdr ni la red.
#
# Cubre:
#   [A] stack_split_ratio: 1/(total-k+1) para lotes de 2, 3 y 4 panes
#       (semantica verificada en el fuente de herdr 0.8.2: el ratio es la
#       fraccion que conserva el pane ORIGINAL, arriba en un split down).
#   [B] (CA-1, CA-2) --parallel con 3 issues: 1 split right (pane de
#       ejecucion) + 2 splits down con ratios parejos; 3 pane run, cada uno
#       con --issues de SU issue, y --delay 30/60 solo en el 2do y 3ro.
#   [C] (CA-3) lote con >=2 tipo:projection aborta con mensaje y NO despacha
#       ningun pane run.
#   [D] (CA-4) issue cerrado se salta con aviso; si ningun issue queda
#       valido, aborta.
#   [E] --from-stage con --parallel aborta (ambiguo sobre un lote), igual que
#       en tmux. Multiples issues sin modo enrutan a --parallel.
#   [F] (CA-5) should_delegate_to_herdr de tmux-pipeline.sh ya no excluye
#       --parallel (delega dentro de herdr) y sigue excluyendo --attach.
#   [G] (issue #1627 CA-4) cmd_infra despacha con MEFISTO_RUNTIME=$HERDR_RUNTIME
#       via dispatch_to_pane, igual que --tooling -- ya lo hacia, se fija con test.
#
# Uso: scripts/tests/test-herdr-parallel.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

export HERDR_STUB_OWNER_PID=$$

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HERDR_SCRIPT="$REPO_ROOT/scripts/herdr-pipeline.sh"
TMUX_SCRIPT="$REPO_ROOT/scripts/tmux-pipeline.sh"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

assert_contains() {
    local desc="$1" haystack="$2" needle="$3"
    if printf '%s' "$haystack" | grep -qF -- "$needle"; then
        pass "$desc"
    else
        fail "$desc -- no se encontro: '$needle'"
    fi
}

assert_not_contains() {
    local desc="$1" haystack="$2" needle="$3"
    if printf '%s' "$haystack" | grep -qF -- "$needle"; then
        fail "$desc -- se encontro indebidamente: '$needle'"
    else
        pass "$desc"
    fi
}

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        pass "$desc"
    else
        fail "$desc -- se esperaba '$expected', fue '$actual'"
    fi
}

extract_fn() {
    local name="$1" file="$2"
    awk -v fn="$name" '$0 ~ "^"fn"\\(\\) \\{" {p=1} p{print} p && /^}/{p=0}' "$file"
}

# --- [A] stack_split_ratio (funcion pura) ---
echo "[A] stack_split_ratio: alturas parejas para lotes de 2, 3 y 4 panes"

body=$(extract_fn stack_split_ratio "$HERDR_SCRIPT")
if [ -n "$body" ]; then
    eval "$body"
    pass "stack_split_ratio extraida y cargable"
else
    fail "stack_split_ratio: no se pudo extraer el cuerpo"
fi

if declare -F stack_split_ratio >/dev/null; then
    assert_eq "total=2 k=1 -> 0.5000 (mitades)" "0.5000" "$(stack_split_ratio 2 1)"
    assert_eq "total=3 k=1 -> 0.3333 (el de arriba conserva 1/3)" "0.3333" "$(stack_split_ratio 3 1)"
    assert_eq "total=3 k=2 -> 0.5000 (el resto se parte parejo)" "0.5000" "$(stack_split_ratio 3 2)"
    assert_eq "total=4 k=1 -> 0.2500" "0.2500" "$(stack_split_ratio 4 1)"
    assert_eq "total=4 k=2 -> 0.3333" "0.3333" "$(stack_split_ratio 4 2)"
    assert_eq "total=4 k=3 -> 0.5000" "0.5000" "$(stack_split_ratio 4 3)"
fi

# --- Entorno de subproceso: consumidor falso + stubs de herdr y gh ---
FAKE_CONSUMER="$(mktemp -d)"
TMP_DIR="$(mktemp -d)"
FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN"
trap 'rm -rf "$FAKE_CONSUMER" "$TMP_DIR"' EXIT

(cd "$FAKE_CONSUMER" && git init -q)

export HERDR_STUB_LOG="$TMP_DIR/herdr-invocations.log"
export HERDR_STUB_COUNTER="$TMP_DIR/herdr-pane-counter"

# Stub de herdr: registra cada invocacion y responde JSON determinista.
#   pane split      -> pane_id incremental w1:pN (contador en archivo)
#   pane get        -> ok (el pane "existe")
#   pane process-info -> pane libre (foreground == shell)
#   pane run        -> ok, y ademas toca el --started-marker de la cmdline
#                      recibida (issue #1563): simula que el shell del pane
#                      ejecuto la linea de inmediato, asi dispatch_to_pane y
#                      cmd_parallel confirman sin esperar el timeout real.
#   pane rename/close -> ok
cat > "$FAKE_BIN/herdr" <<'STUB'
#!/usr/bin/env bash
set -u
echo "herdr $*" >> "$HERDR_STUB_LOG"
case "${1:-} ${2:-}" in
    "pane split")
        n=$(cat "$HERDR_STUB_COUNTER" 2>/dev/null || echo 0)
        n=$((n + 1))
        echo "$n" > "$HERDR_STUB_COUNTER"
        echo "{\"result\":{\"pane\":{\"pane_id\":\"w1:p$n\"}}}"
        ;;
    "pane get")
        echo '{"result":{"pane":{"pane_id":"stub"}}}'
        ;;
    "pane process-info")
        # Issue #2285: el guard de pane propio exige que el wrapper descienda del
        # shell_pid del pane despachante (HERDR_PANE_ID); se reporta el PID del test.
        if [ -n "${HERDR_STUB_OWNER_PID:-}" ] && [ "${4:-}" = "${HERDR_PANE_ID:-}" ]; then
            echo "{\"result\":{\"process_info\":{\"shell_pid\":$HERDR_STUB_OWNER_PID,\"foreground_process_group_id\":$HERDR_STUB_OWNER_PID}}}"
            exit 0
        fi
        id="${4:-}"
        for o in ${HERDR_STUB_OCCUPIED:-}; do
            if [ "$o" = "$id" ]; then
                echo '{"result":{"process_info":{"shell_pid":100,"foreground_process_group_id":200}}}'
                exit 0
            fi
        done
        echo '{"result":{"process_info":{"shell_pid":100,"foreground_process_group_id":100}}}'
        ;;
    "pane run")
        cmdline="${4:-}"
        marker=$(printf '%s\n' "$cmdline" | grep -oE -- '--started-marker [^[:space:]]+' | awk '{print $2}')
        if [ -n "$marker" ]; then
            mkdir -p "$(dirname "$marker")" 2>/dev/null
            : > "$marker"
        fi
        echo '{"result":{"type":"ok"}}'
        ;;
    *)
        echo '{"result":{"type":"ok"}}'
        ;;
esac
STUB
chmod +x "$FAKE_BIN/herdr"

# Stub de gh: responde a `gh issue view N --json state,labels -q <template>`
# con la linea "STATE|labels" que resolve_issue_facts espera. El estado y los
# labels se derivan del numero de issue:
#   42/43/44 -> OPEN,  tipo:tooling
#   50/51    -> OPEN,  tipo:projection
#   60       -> CLOSED, tipo:tooling
cat > "$FAKE_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -u
issue="${3:-}"
case "$issue" in
    42|43|44) printf 'OPEN|tipo:tooling\n' ;;
    50|51)    printf 'OPEN|tipo:projection\ndom:x\n' ;;
    60)       printf 'CLOSED|tipo:tooling\n' ;;
    *)        exit 1 ;;
esac
STUB
chmod +x "$FAKE_BIN/gh"

# Contexto herdr falso para el subproceso. MEFISTO_UI se limpia por si el
# entorno del test lo trae (forzaria tmux en tmux-pipeline.sh, no aqui).
run_parallel() {
    : > "$HERDR_STUB_LOG"
    echo 0 > "$HERDR_STUB_COUNTER"
    (
        cd "$FAKE_CONSUMER" || exit 99
        env -u MEFISTO_UI -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR \
            PATH="$FAKE_BIN:$PATH" \
            MEFISTO_RUNTIME="${HERDR_TEST_RUNTIME:-claude}" HERDR_ENV=1 HERDR_PANE_ID="w1:p0" HERDR_WORKSPACE_ID="w1" \
            HERDR_STUB_LOG="$HERDR_STUB_LOG" HERDR_STUB_COUNTER="$HERDR_STUB_COUNTER" \
            "$HERDR_SCRIPT" "$@" 2>&1
    )
}

# --- [B] Lote de 3 issues: apilado + despacho escalonado ---
echo "[B] --parallel con 3 issues: panes apilados y pane run escalonados"

OUT=$(run_parallel --parallel --pipeline tooling 42 43 44)
RC=$?
STUB_CALLS=$(cat "$HERDR_STUB_LOG")

assert_eq "exit code 0" "0" "$RC"
assert_contains "pane de ejecucion: split right desde el pane que despacha" "$STUB_CALLS" "pane split --pane w1:p0 --direction right"
assert_contains "2do pane: split down del pane de ejecucion con ratio 1/3" "$STUB_CALLS" "pane split --pane w1:p1 --direction down --ratio 0.3333"
assert_contains "3er pane: split down del 2do con ratio 1/2" "$STUB_CALLS" "pane split --pane w1:p2 --direction down --ratio 0.5000"
assert_eq "exactamente 3 pane run" "3" "$(grep -c "^herdr pane run" <<< "$STUB_CALLS")"
assert_contains "issue 42 en el pane de ejecucion, con su visor filtrado" "$STUB_CALLS" "pane run w1:p1"
assert_contains "run del issue 42 filtra --issues 42" "$STUB_CALLS" "--issues 42"
assert_contains "run del issue 43 en el 2do pane" "$STUB_CALLS" "pane run w1:p2"
assert_contains "run del issue 44 en el 3er pane" "$STUB_CALLS" "pane run w1:p3"
assert_contains "2do issue arranca escalonado (--delay 30)" "$STUB_CALLS" "--delay 30"
assert_contains "3er issue arranca escalonado (--delay 60)" "$STUB_CALLS" "--delay 60"
FIRST_RUN=$(grep "^herdr pane run w1:p1 " <<< "$STUB_CALLS")
assert_not_contains "el 1er issue arranca sin delay" "$FIRST_RUN" "--delay"
assert_contains "los panes corren el runner interno" "$STUB_CALLS" "--_pane-runner"
assert_contains "el runner recibe el runtime resuelto argv-safe" "$STUB_CALLS" "MEFISTO_RUNTIME=claude"
assert_not_contains "no delega a tmux" "$OUT" "tmux"
PANES_STATE="$FAKE_CONSUMER/.mefisto/pipeline/herdr-report-panes.txt"
assert_eq "--parallel registra todos los panes con runtime Claude" \
    $'w1:p1 claude\nw1:p2 claude\nw1:p3 claude' "$(cat "$PANES_STATE")"

# Una segunda corrida del mismo runtime no reutiliza el pane ocupado y registra
# el split nuevo con la misma clave, sin cerrar ni borrar el ocupado.
printf 'w1:p9 claude\n' > "$PANES_STATE"
OUT=$(HERDR_STUB_OCCUPIED=w1:p9 run_parallel --tooling 42)
RC=$?
STUB_CALLS=$(cat "$HERDR_STUB_LOG")
assert_eq "pane propio ocupado: exit 0" "0" "$RC"
assert_contains "pane propio ocupado: crea split desde HERDR_PANE_ID" "$STUB_CALLS" "pane split --pane w1:p0 --direction right"
assert_not_contains "pane propio ocupado: no se reutiliza" "$STUB_CALLS" "pane run w1:p9"
assert_contains "pane propio ocupado permanece registrado" "$(cat "$PANES_STATE")" "w1:p9 claude"
assert_contains "split adicional se registra con Claude" "$(cat "$PANES_STATE")" "w1:p1 claude"

# El pool legacy nunca participa: la primera corrida de otro runtime crea el canonico
# seguro y deja intactos los bytes legacy.
rm -f "$PANES_STATE"
LEGACY_STATE="$FAKE_CONSUMER/.claude/pipeline/herdr-report-panes.txt"
mkdir -p "$(dirname "$LEGACY_STATE")"
printf 'w1:legacy\n' > "$LEGACY_STATE"
LEGACY_BEFORE=$(shasum "$LEGACY_STATE")
OUT=$(HERDR_TEST_RUNTIME=fake run_parallel --tooling 42)
RC=$?
STUB_CALLS=$(cat "$HERDR_STUB_LOG")
assert_eq "otro runtime con solo pool legacy: exit 0" "0" "$RC"
assert_contains "otro runtime crea pane nuevo, no reutiliza legacy" "$STUB_CALLS" "pane split --pane w1:p0 --direction right"
assert_eq "pool canonico nuevo usa formato exacto" "w1:p1 fake" "$(cat "$PANES_STATE")"
assert_eq "pool legacy queda byte a byte intacto" "$LEGACY_BEFORE" "$(shasum "$LEGACY_STATE")"
assert_contains "el runner recibe el runtime explicito" "$STUB_CALLS" "MEFISTO_RUNTIME=fake"

# El runtime se resuelve antes de consultar o modificar el pool: uno invalido
# aborta visible y no alcanza split/run/close.
POOL_BEFORE=$(shasum "$PANES_STATE")
OUT=$(HERDR_TEST_RUNTIME=invalido run_parallel --parallel --pipeline tooling 42)
RC=$?
STUB_CALLS=$(cat "$HERDR_STUB_LOG")
assert_eq "runtime invalido: exit 1 antes del pool" "1" "$RC"
assert_contains "runtime invalido expone MEFISTO_RUNTIME_ERROR" "$OUT" "No se pudo resolver el runtime activo"
assert_not_contains "runtime invalido no crea pane" "$STUB_CALLS" "pane split"
assert_not_contains "runtime invalido no ejecuta pane" "$STUB_CALLS" "pane run"
assert_not_contains "runtime invalido no cierra pane" "$STUB_CALLS" "pane close"
assert_eq "runtime invalido no modifica el pool" "$POOL_BEFORE" "$(shasum "$PANES_STATE")"

# --- [C] Gate de projections ---
echo "[C] Lote con >=2 tipo:projection aborta sin despachar"

OUT=$(run_parallel --parallel 50 51)
RC=$?
STUB_CALLS=$(cat "$HERDR_STUB_LOG")

assert_eq "exit code distinto de 0" "1" "$RC"
assert_contains "el mensaje nombra tipo:projection" "$OUT" "tipo:projection"
assert_contains "el mensaje apunta a /sequential" "$OUT" "/sequential"
assert_not_contains "ningun pane run despachado" "$STUB_CALLS" "pane run"
assert_not_contains "ningun pane creado" "$STUB_CALLS" "pane split"

# Una sola projection en el lote SI pasa (se serializa sola por definicion).
OUT=$(run_parallel --parallel 50 42)
RC=$?
assert_eq "una projection + un tooling: exit 0" "0" "$RC"

# --- [D] Issues no validos ---
echo "[D] Issues cerrados se saltan; lote sin validos aborta"

OUT=$(run_parallel --parallel 60 42)
RC=$?
STUB_CALLS=$(cat "$HERDR_STUB_LOG")
assert_eq "exit 0 (queda un issue valido)" "0" "$RC"
assert_contains "aviso del issue cerrado" "$OUT" "#60 esta CLOSED"
assert_eq "solo 1 pane run (el del issue valido)" "1" "$(grep -c "^herdr pane run" <<< "$STUB_CALLS")"

OUT=$(run_parallel --parallel 60)
RC=$?
assert_eq "lote sin issues validos: exit 1" "1" "$RC"
assert_contains "mensaje de lote vacio" "$OUT" "No hay issues validos"

# --- [E] Pre-parseo: --from-stage y fallback multi-issue ---
echo "[E] --from-stage con --parallel aborta; multiples issues enrutan a --parallel"

OUT=$(run_parallel --parallel 42 43 --from-stage 3)
RC=$?
assert_eq "--from-stage con --parallel: exit 1" "1" "$RC"
assert_contains "mensaje de ambiguedad" "$OUT" "--from-stage no es valido con --parallel"

OUT=$(run_parallel --pipeline tooling 42 43)
RC=$?
STUB_CALLS=$(cat "$HERDR_STUB_LOG")
assert_eq "multiples issues sin modo: exit 0" "0" "$RC"
assert_contains "aviso del fallback" "$OUT" "Usando --parallel"
assert_eq "2 pane run despachados" "2" "$(grep -c "^herdr pane run" <<< "$STUB_CALLS")"

# --- [F] Autodeteccion en tmux-pipeline.sh ---
echo "[F] should_delegate_to_herdr: --parallel delega, --attach no"

body=$(extract_fn should_delegate_to_herdr "$TMUX_SCRIPT")
if [ -n "$body" ]; then
    eval "$body"
    pass "should_delegate_to_herdr extraida y cargable"
else
    fail "should_delegate_to_herdr: no se pudo extraer el cuerpo"
fi

if declare -F should_delegate_to_herdr >/dev/null; then
    # Contexto herdr simulado en ESTE proceso (el stub en PATH cubre `command -v herdr`).
    if ( unset MEFISTO_UI
         export HERDR_ENV=1 HERDR_PANE_ID="w1:p0" PATH="$FAKE_BIN:$PATH"
         should_delegate_to_herdr --parallel 42 43 ); then
        pass "--parallel delega a herdr dentro de un pane herdr"
    else
        fail "--parallel deberia delegar a herdr dentro de un pane herdr"
    fi
    if ( unset MEFISTO_UI
         export HERDR_ENV=1 HERDR_PANE_ID="w1:p0" PATH="$FAKE_BIN:$PATH"
         should_delegate_to_herdr --attach foo ); then
        fail "--attach no deberia delegar (es tmux-especifico)"
    else
        pass "--attach sigue sin delegar"
    fi
    if ( unset HERDR_ENV MEFISTO_UI 2>/dev/null
         should_delegate_to_herdr --parallel 42 43 ); then
        fail "fuera de herdr no deberia delegar"
    else
        pass "fuera de herdr no delega"
    fi
fi

# --- [G] cmd_infra: MEFISTO_RUNTIME=$HERDR_RUNTIME propagado (issue #1627 CA-4) ---
echo "[G] --infra despacha con MEFISTO_RUNTIME=\$HERDR_RUNTIME, igual que --tooling"

OUT=$(run_parallel --infra 42)
RC=$?
STUB_CALLS=$(cat "$HERDR_STUB_LOG")
assert_eq "--infra: exit 0" "0" "$RC"
assert_contains "--infra: el runner corre iac-pipeline.sh" "$STUB_CALLS" "iac-pipeline.sh"
assert_contains "--infra: runner recibe MEFISTO_RUNTIME=claude" "$STUB_CALLS" "MEFISTO_RUNTIME=claude"

OUT=$(HERDR_TEST_RUNTIME=fake run_parallel --infra 42)
RC=$?
STUB_CALLS=$(cat "$HERDR_STUB_LOG")
assert_eq "--infra (fake): exit 0" "0" "$RC"
assert_contains "--infra (fake): runner recibe MEFISTO_RUNTIME=fake" "$STUB_CALLS" "MEFISTO_RUNTIME=fake"

# --- Resumen ---
echo ""
echo "Resultado: $PASS PASS, $FAIL FAIL"
[ "$FAIL" -eq 0 ]
