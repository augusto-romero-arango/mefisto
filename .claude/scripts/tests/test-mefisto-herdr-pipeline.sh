#!/usr/bin/env bash
# test-mefisto-herdr-pipeline.sh -- Tests dedicados del porte de
# mefisto-herdr-pipeline.sh al layout canonico src/internal/scripts/
# (MEF-ADR-0049, issue #872). Contraparte interna de test-caffeinate-prefix.sh
# / test-herdr-*.sh (lado publicado): mismo contrato de UX, verificado sobre
# la copia interna -- MEF-ADR-0019 prohibe compartir codigo entre los dos
# lados, asi que este archivo no importa nada del publicado ni de los otros
# tests internos que ya tocan mefisto-herdr-pipeline.sh (test-mefisto-tooling-variant.sh,
# test-mefisto-stage-models.sh, test-tooling-state-paths.sh).
#
# Cubre (CA-6 de #872; el pool con clave de runtime es CA-1..CA-6 de #928):
#   [1-4] --tooling/--batch heredan MEFISTO_RUNTIME=claude|fake (y
#         MEFISTO_MODELS_FILE) en el pane run, antepuestos como asignacion de
#         entorno a la invocacion del runner (CA-2 de #872).
#   [5]   Sin MEFISTO_RUNTIME/MEFISTO_MODELS_FILE fijados, el pane run no
#         lleva ninguna asignacion de entorno (ENV_PREFIX vacio no cambia el
#         comportamiento de autodeteccion respecto de no fijarlo).
#   [6-7] Argumentos con caracteres especiales (corchetes, comas, comillas
#         simples de un id de modelo) llegan intactos al pane run -- printf %q
#         los escapa como dato, nunca se re-emiten crudos.
#   [8-12] Argumentos faltantes: --tooling sin issue, --batch sin issues,
#         --models/--variant/--from-stage sin valor abortan con mensaje claro.
#   [13-15] Combinaciones invalidas: --batch rechaza --models, --variant y
#         --from-stage (serian ambiguos sobre varios issues) sin despachar
#         ningun pane.
#   [16]  Reutilizacion de un pane libre ya registrado del MISMO runtime: no
#         crea un pane nuevo (sin "pane split" en el log) -- pool con clave
#         (issue #928).
#   [17]  Un pane registrado pero ocupado se descarta: crea uno nuevo via
#         "pane split" en vez de reusarlo.
#   [18]  CA-1 (#928): con claude y fake disponibles a la vez y sin
#         MEFISTO_RUNTIME, acquire_report_pane aborta con el texto de
#         MEFISTO_RUNTIME_ERROR ANTES de tocar el pool -- cero herdr pane
#         split/run/close y el archivo del pool queda intacto.
#   [19]  CA-2 (#928): un despacho que crea pane nuevo escribe la linea con
#         clave "<pane_id> <runtime>" en el pool.
#   [20]  CA-3 (#928): con el pool en "w1:p9 claude" libre y un despacho
#         fake, se crea pane nuevo (no se reutiliza ni se cierra el de
#         otro runtime) y "w1:p9 claude" sigue en el archivo.
#   [21]  CA-4 (#928): la poda de panes libres sobrantes solo considera el
#         mismo runtime -- con "w1:p8 fake"/"w1:p9 fake"/"w1:p7 claude"
#         libres y un despacho fake, se reutiliza w1:p8, se cierra w1:p9 y
#         w1:p7 (otro runtime) ni se cierra ni sale del pool.
#   [22]  CA-5 (#928): una linea legacy sin clave de runtime ("w1:p9") se
#         descarta del pool al primer barrido, sin "herdr pane close" -- costo
#         unico de migracion.
#   [24-26] Flags que se consumen o se reenvian (CA-3 de #872): --if-exists y
#         --attach abortan con un error explicito; --from-stage y --variant
#         si viajan con su valor, y --from-stage no numerico aborta antes de
#         despachar.
#   [27]  Guard de contexto herdr (CA-5 de #872): sin HERDR_ENV=1 aborta
#         remitiendo a mefisto-launch-pipeline.sh, sin despachar ningun pane.
#   [28]  Guard estatico del canonico REAL (CA-4 de #872 + CA-6 de #928),
#         contraparte del bloque [B] de test-batch-runtime.sh: cero menciones
#         de "claude -p", estado resuelto con mefisto_state_path (logs y
#         registro de panes), cero ".claude/pipeline" en codigo, las unicas
#         referencias ".claude/scripts" en codigo son la invocacion del visor
#         -- que sigue viviendo ahi porque #878 neutralizo su fuente de datos,
#         no su ubicacion (mismo caso que mefisto-launch-pipeline.sh tras #871)
#         -- y cero defaults literales de runtime (ningun ":-claude",
#         issue #928 CA-6: el runtime se resuelve siempre con
#         mefisto_resolve_runtime, nunca incrustado en esta capa neutral).
#   [29]  tail -f en vivo del .report.log dentro de --_pane-runner (issue
#         #926, CA-1/2/3): sin HERDR_PANE_ID en el entorno, un comando falso
#         que imprime una linea, duerme 3s e imprime otra prueba que la
#         primera linea llega a la captura del pane ANTES de que el comando
#         termine, que al final ambas lineas aparecen exactamente una vez (sin
#         duplicarse con un cat/tail final, que CA-2 elimina), que el visor y
#         el tail comparten ese unico pane, que el rc devuelto es el del
#         comando falso (exit 0 y exit 7) y que no queda ningun `tail -f` del
#         reporte vivo tras la corrida (CA-3). No pasa por acquire_report_pane
#         (el runner interno no resuelve runtime, issue #928 nota tecnica), asi
#         que no depende del stub de claude en PATH.
#   [30-33] Confirmacion de arranque del runner (issue #1563, porte #1571):
#         mismo mecanismo que scripts/tests/test-herdr-dispatch-confirm.sh del
#         lado publicado. [30] arranque confirmado al primer intento: un solo
#         "pane split"/"pane run", sin aviso de reintento. [31] fallo del
#         primer arranque (pane en HERDR_STUB_NEVER_CONFIRM): reintenta UNA
#         vez en un pane nuevo, nunca vuelve a escribir en el sospechoso, y el
#         exito final nombra ambos panes. [32] fallo doble (ni el original ni
#         el reintento confirman): exit distinto de 0, mensaje nombra ambos
#         panes y sugiere cerrarlos, sin mensaje de exito. [33] invoca
#         --_pane-runner directo con un --started-marker ya reclamado: aborta
#         sin lanzar el sub-pipeline (MEF-ADR-0017).
#
# Uso: .claude/scripts/tests/test-mefisto-herdr-pipeline.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# --- Fixture: repo de mentira con el canonico + su shim ---------------------
#
# Mismo arnes que test-mefisto-tooling-variant.sh: .claude-plugin/plugin.json
# (assert_in_mefisto lo exige), copias reales de los scripts y un stub de
# herdr en PATH que solo registra la invocacion sin tocar un servidor real.

TMP_DIR="$(mktemp -d)"
FAKE_MEFISTO="$TMP_DIR/fake-mefisto"
FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_MEFISTO/.claude-plugin" "$FAKE_MEFISTO/.claude/scripts" "$FAKE_MEFISTO/src/internal/scripts/lib" "$FAKE_BIN"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$FAKE_MEFISTO/.claude-plugin/plugin.json" <<'EOF'
{
  "name": "mefisto",
  "version": "0.0.0"
}
EOF
printf '.mefisto/\n' > "$FAKE_MEFISTO/.gitignore"
cp "$REPO_ROOT/src/internal/scripts/lib/_mefisto-common.sh" "$FAKE_MEFISTO/src/internal/scripts/lib/_mefisto-common.sh"
cp "$REPO_ROOT/src/internal/scripts/lib/mefisto-state.sh" "$FAKE_MEFISTO/src/internal/scripts/lib/mefisto-state.sh"
cp -R "$REPO_ROOT/src/runtime" "$FAKE_MEFISTO/src/runtime"
cp "$REPO_ROOT/src/internal/scripts/mefisto-herdr-pipeline.sh" "$FAKE_MEFISTO/src/internal/scripts/mefisto-herdr-pipeline.sh"
cp "$REPO_ROOT/.claude/scripts/mefisto-herdr-pipeline.sh" "$FAKE_MEFISTO/.claude/scripts/mefisto-herdr-pipeline.sh"

# Discovery y adaptadores se resuelven desde el nucleo comun del fixture.

# Stub del visor: el runner interno (bloque 24) lo lanza en background contra
# la ruta explicita ".claude/scripts/mefisto-stream-watch.sh" del repo. Sin
# stub, bash escupe un "No such file or directory" al mismo stdout que se
# captura y el bloque nunca ejercita lo que el issue #926 promete -- visor y
# `tail -f` compartiendo un unico pane. Emite su marca y `exec`-a el sleep
# para que el PID que el runner mata sea el del propio sleep (sin exec, kill
# mataria al bash envolvente y dejaria el sleep huerfano).
cat > "$FAKE_MEFISTO/.claude/scripts/mefisto-stream-watch.sh" <<'STUB'
#!/usr/bin/env bash
echo "visor-stub-arrancado"
exec sleep 30
STUB
chmod +x "$FAKE_MEFISTO/.claude/scripts/mefisto-stream-watch.sh"
(cd "$FAKE_MEFISTO" && git init -q && git add . && git -c user.email="test@example.com" -c user.name="Test" commit -q -m "commit inicial" && git branch -M main)
BARE_ORIGIN="$TMP_DIR/origin.git"
PUBLISHER="$TMP_DIR/publisher"
git init -q --bare "$BARE_ORIGIN"
git -C "$BARE_ORIGIN" symbolic-ref HEAD refs/heads/main
git -C "$FAKE_MEFISTO" remote add origin "$BARE_ORIGIN"
git -C "$FAKE_MEFISTO" push -q -u origin main
git clone -q "$BARE_ORIGIN" "$PUBLISHER"
git -C "$PUBLISHER" config user.email "test@example.com"
git -C "$PUBLISHER" config user.name "Test"

cat > "$FAKE_BIN/gh" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod +x "$FAKE_BIN/gh"

# Stub de "claude" (issue #928): unico runtime visible por defecto dentro del
# PATH restringido de run_herdr (ver mas abajo), asi la autodeteccion de
# mefisto_resolve_runtime resuelve siempre "claude" en los tests que no fijan
# MEFISTO_RUNTIME explicitamente -- sin esto, la maquina real que corre la
# suite (con o sin un claude instalado de verdad) haria la autodeteccion
# no determinista. El bloque [18] (CA-1, runtimes ambiguos) declara disponible
# el adaptador fake solo durante su corrida.
cat > "$FAKE_BIN/claude" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$FAKE_BIN/claude"

# HERDR_STUB_FREE controla la respuesta de "pane process-info" (bloques
# 16/17): "true" (default) simula un pane en su prompt interactivo; "false"
# simula un pane con un comando en foreground (ocupado).
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
        if [ -n "${HERDR_STUB_OWNER_PID:-}" ] && [ "${4:-}" = "w1:p0" ]; then
            echo "{\"result\":{\"process_info\":{\"shell_pid\":$HERDR_STUB_OWNER_PID,\"foreground_process_group_id\":$HERDR_STUB_OWNER_PID}}}"
        elif [ "${HERDR_STUB_FREE:-true}" = "true" ]; then
            echo '{"result":{"process_info":{"shell_pid":100,"foreground_process_group_id":100}}}'
        else
            echo '{"result":{"process_info":{"shell_pid":100,"foreground_process_group_id":200}}}'
        fi
        ;;
    "pane run")
        # Confirmacion de arranque (issue #1563, porte #1571): toca el
        # --started-marker de la cmdline, salvo que el pane destino este
        # listado en HERDR_STUB_NEVER_CONFIRM -- simula el shell atascado que
        # nunca ejecuto --_pane-runner (certificacion v0.38.2 del publicado).
        pane_id="${3:-}"
        cmdline="${4:-}"
        confirm=1
        for bad in ${HERDR_STUB_NEVER_CONFIRM:-}; do
            [ "$bad" = "$pane_id" ] && confirm=0
        done
        if [ "$confirm" -eq 1 ]; then
            marker=$(printf '%s\n' "$cmdline" | grep -oE -- '--started-marker [^[:space:]]+' | awk '{print $2}')
            if [ -n "$marker" ]; then
                mkdir -p "$(dirname "$marker")" 2>/dev/null
                : > "$marker"
            fi
        fi
        echo '{"result":{"type":"ok"}}'
        ;;
    *)
        echo '{"result":{"type":"ok"}}'
        ;;
esac
STUB
chmod +x "$FAKE_BIN/herdr"

export HERDR_STUB_LOG="$TMP_DIR/herdr-invocations.log"
export HERDR_STUB_COUNTER="$TMP_DIR/herdr-pane-counter"
HERDR_SCRIPT="$FAKE_MEFISTO/.claude/scripts/mefisto-herdr-pipeline.sh"

LAST_STDOUT=""
LAST_STDERR=""
LAST_RC=0

# run_herdr [args...]
#
# Corre el shim (que reenvia al canonico via exec) dentro de un pane herdr
# simulado. Hereda MEFISTO_RUNTIME/MEFISTO_MODELS_FILE si el caller los tiene
# exportados en su propio entorno -- asi los bloques 1-5 solo necesitan
# export/unset alrededor de la llamada, igual que en una corrida real donde el
# comando generado los antepone al invocar el launcher.
#
# Las -u de MEFISTO_STATE_DIR/MEFISTO_LEGACY_STATE_DIR/MEFISTO_REPO_ROOT/
# MEFISTO_PROJECT_NAME/MEFISTO_REPO_SLUG son necesarias: si este test corre
# DENTRO de una corrida real de mefisto-tooling-pipeline.sh (como la que lo
# escribio), esas variables ya llegan exportadas al proceso apuntando al repo
# REAL -- sin desarmarlas aqui, mefisto-state.sh (`: "${VAR:=default}"`) las
# respeta tal cual y el fixture deja de escribir en su propio
# FAKE_MEFISTO/.mefisto/pipeline/ para escribir en el .mefisto/pipeline/ del
# repo que orquesta esta misma sesion (visto en vivo: un primer intento sin
# estas -u filtro el registro de panes del checkout real).
#
# PATH="$FAKE_BIN:/usr/bin:/bin" (issue #928), no "$FAKE_BIN:$PATH": desde que
# acquire_report_pane resuelve el runtime con mefisto_resolve_runtime, un
# "command -v claude" que se cuele hasta un CLI real
# (tipicamente en ~/.local/bin o /opt/homebrew/bin, fuera de este PATH
# recortado) haria la autodeteccion no determinista segun lo que tenga
# instalado la maquina que corre la suite. /usr/bin y /bin alcanzan para git,
# jq y el resto de coreutils que el canonico y _mefisto-common.sh usan.
run_herdr() {
    : > "$HERDR_STUB_LOG"
    echo 0 > "$HERDR_STUB_COUNTER"
    local out="$TMP_DIR/stdout" err="$TMP_DIR/stderr"
    (
        cd "$FAKE_MEFISTO" || exit 99
        env -u MEFISTO_UI \
            -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR \
            -u MEFISTO_REPO_ROOT -u MEFISTO_PROJECT_NAME -u MEFISTO_REPO_SLUG \
            PATH="$FAKE_BIN:/usr/bin:/bin" \
            HERDR_ENV=1 HERDR_PANE_ID="w1:p0" HERDR_WORKSPACE_ID="w1" \
            HERDR_STUB_LOG="$HERDR_STUB_LOG" HERDR_STUB_COUNTER="$HERDR_STUB_COUNTER" \
            HERDR_STUB_FREE="${HERDR_STUB_FREE:-true}" \
            HERDR_STUB_OWNER_PID="${HERDR_STUB_OWNER_PID-$$}" \
            "$HERDR_SCRIPT" "$@"
    ) </dev/null >"$out" 2>"$err"
    LAST_RC=$?
    LAST_STDOUT=$(cat "$out")
    LAST_STDERR=$(cat "$err")
}

# Punto de partida explicito (issue #928): esta suite corre a menudo DENTRO
# de una corrida real del pipeline interno, que exporta MEFISTO_RUNTIME. Los
# bloques que ejercen la ausencia de la variable ([5], [18], [22]) no pueden
# depender de que un `unset` de otro bloque anterior la haya limpiado por
# casualidad -- run_herdr no puede desfijarla, porque [1-4] verifican
# justamente que se herede. Se limpia una vez aqui y cada bloque que la
# necesita la exporta y la vuelve a desfijar.
unset MEFISTO_RUNTIME MEFISTO_MODELS_FILE

# --- [1-4] MEFISTO_RUNTIME/MEFISTO_MODELS_FILE heredados en el pane (CA-2) --

echo "[1] --tooling hereda MEFISTO_RUNTIME=claude en el pane run"
export MEFISTO_RUNTIME=claude
run_herdr --tooling 872
unset MEFISTO_RUNTIME
if [ "$LAST_RC" -eq 0 ]; then pass "--tooling corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if grep -qF "MEFISTO_RUNTIME=claude" "$HERDR_STUB_LOG" && grep -q "pane run" "$HERDR_STUB_LOG"; then
    pass "el pane run lleva MEFISTO_RUNTIME=claude"
else
    fail "el pane run no lleva MEFISTO_RUNTIME=claude -- log: $(cat "$HERDR_STUB_LOG")"
fi
if grep -qF "mefisto-tooling-pipeline.sh 872" "$HERDR_STUB_LOG"; then
    pass "el runner reenvia a mefisto-tooling-pipeline.sh con el issue"
else
    fail "no se reenvio a mefisto-tooling-pipeline.sh -- log: $(cat "$HERDR_STUB_LOG")"
fi

echo ""
echo "[2] --tooling hereda MEFISTO_RUNTIME=fake y MEFISTO_MODELS_FILE en el pane run"
export MEFISTO_RUNTIME=fake
export MEFISTO_MODELS_FILE=/tmp/modelos-de-mentira.json
run_herdr --tooling 872
unset MEFISTO_RUNTIME MEFISTO_MODELS_FILE
if [ "$LAST_RC" -eq 0 ]; then pass "--tooling corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if grep -qF "MEFISTO_RUNTIME=fake" "$HERDR_STUB_LOG"; then
    pass "el pane run lleva MEFISTO_RUNTIME=fake"
else
    fail "el pane run no lleva MEFISTO_RUNTIME=fake -- log: $(cat "$HERDR_STUB_LOG")"
fi
if grep -qF "MEFISTO_MODELS_FILE=/tmp/modelos-de-mentira.json" "$HERDR_STUB_LOG"; then
    pass "el pane run lleva MEFISTO_MODELS_FILE"
else
    fail "el pane run no lleva MEFISTO_MODELS_FILE -- log: $(cat "$HERDR_STUB_LOG")"
fi

echo ""
echo "[3] --batch hereda MEFISTO_RUNTIME=claude en el pane run"
export MEFISTO_RUNTIME=claude
run_herdr --batch 872 873
unset MEFISTO_RUNTIME
if [ "$LAST_RC" -eq 0 ]; then pass "--batch corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if grep -qF "MEFISTO_RUNTIME=claude" "$HERDR_STUB_LOG" && grep -qF "mefisto-batch-pipeline.sh 872 873" "$HERDR_STUB_LOG"; then
    pass "el pane run lleva MEFISTO_RUNTIME=claude y reenvia a mefisto-batch-pipeline.sh con ambos issues"
else
    fail "despacho de batch incompleto -- log: $(cat "$HERDR_STUB_LOG")"
fi

echo ""
echo "[4] --batch hereda MEFISTO_RUNTIME=fake en el pane run"
export MEFISTO_RUNTIME=fake
run_herdr --batch 872 873
unset MEFISTO_RUNTIME
if [ "$LAST_RC" -eq 0 ]; then pass "--batch corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if grep -qF "MEFISTO_RUNTIME=fake" "$HERDR_STUB_LOG"; then
    pass "el pane run lleva MEFISTO_RUNTIME=fake"
else
    fail "el pane run no lleva MEFISTO_RUNTIME=fake -- log: $(cat "$HERDR_STUB_LOG")"
fi

echo ""
echo "[5] sin MEFISTO_RUNTIME/MEFISTO_MODELS_FILE fijados, el pane run no lleva ninguna asignacion de entorno"
run_herdr --tooling 872
if [ "$LAST_RC" -eq 0 ]; then pass "--tooling corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if grep -q "MEFISTO_RUNTIME=" "$HERDR_STUB_LOG"; then
    fail "el pane run no deberia mencionar MEFISTO_RUNTIME sin fijarlo -- log: $(cat "$HERDR_STUB_LOG")"
else
    pass "ENV_PREFIX vacio: nada de MEFISTO_RUNTIME en el pane run"
fi

echo ""
echo "----------------------------------------"
echo "  Herencia de entorno: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

# --- [6-7] Argumentos con caracteres especiales sobreviven a printf %q ------

echo ""
echo "[6] --models con corchetes y coma llega intacto al pane run"
run_herdr --tooling 872 --models "writer=claude-opus-5[1m],reviewer=sonnet"
if [ "$LAST_RC" -eq 0 ]; then pass "corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
EXPECTED_Q=$(printf '%q' "writer=claude-opus-5[1m],reviewer=sonnet")
if grep -qF -- "--models $EXPECTED_Q" "$HERDR_STUB_LOG"; then
    pass "el valor de --models llega escapado con printf %q, sin alterar corchetes ni coma"
else
    fail "el valor de --models no llego intacto -- log: $(cat "$HERDR_STUB_LOG")"
fi

echo ""
echo "[7] un valor de --models con comilla simple embebida llega intacto (printf %q, nunca crudo)"
run_herdr --tooling 872 --models "writer=modelo-de-'prueba"
if [ "$LAST_RC" -eq 0 ]; then pass "corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
EXPECTED_Q=$(printf '%q' "writer=modelo-de-'prueba")
if grep -qF -- "--models $EXPECTED_Q" "$HERDR_STUB_LOG"; then
    pass "la comilla simple embebida sobrevive escapada, no cruda"
else
    fail "el valor con comilla simple no llego intacto -- log: $(cat "$HERDR_STUB_LOG")"
fi

echo ""
echo "----------------------------------------"
echo "  Caracteres especiales: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

# --- [8-12] Argumentos faltantes ---------------------------------------------

echo ""
echo "[8] --tooling sin numero de issue aborta con mensaje claro"
run_herdr --tooling
if [ "$LAST_RC" -eq 1 ]; then pass "aborta (rc=$LAST_RC)"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "Falta el numero de issue"; then pass "mensaje: falta el numero de issue"; else fail "mensaje inesperado: $LAST_STDERR"; fi

echo ""
echo "[9] --batch sin issues aborta con mensaje claro"
run_herdr --batch
if [ "$LAST_RC" -eq 1 ]; then pass "aborta (rc=$LAST_RC)"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "al menos un issue"; then pass "mensaje: al menos un issue"; else fail "mensaje inesperado: $LAST_STDERR"; fi

echo ""
echo "[10] --models sin valor aborta con mensaje claro"
run_herdr --tooling 872 --models
if [ "$LAST_RC" -eq 1 ]; then pass "aborta (rc=$LAST_RC)"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "Falta el valor de --models"; then pass "mensaje: falta el valor de --models"; else fail "mensaje inesperado: $LAST_STDERR"; fi

echo ""
echo "[11] --variant sin valor aborta con mensaje claro"
run_herdr --tooling 872 --variant
if [ "$LAST_RC" -eq 1 ]; then pass "aborta (rc=$LAST_RC)"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "Falta el valor de --variant"; then pass "mensaje: falta el valor de --variant"; else fail "mensaje inesperado: $LAST_STDERR"; fi

echo ""
echo "[12] --from-stage sin valor aborta con mensaje claro"
run_herdr --tooling 872 --from-stage
if [ "$LAST_RC" -eq 1 ]; then pass "aborta (rc=$LAST_RC)"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "Falta el valor de --from-stage"; then pass "mensaje: falta el valor de --from-stage"; else fail "mensaje inesperado: $LAST_STDERR"; fi

echo ""
echo "----------------------------------------"
echo "  Argumentos faltantes: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

# --- [13-15] Combinaciones invalidas -----------------------------------------

echo ""
echo "[13] --batch + --models aborta (ambiguo sobre varios issues) sin despachar ningun pane"
run_herdr --batch 872 873 --models "writer=sonnet"
if [ "$LAST_RC" -eq 1 ]; then pass "aborta (rc=$LAST_RC)"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "no es valido con --batch"; then pass "mensaje: --models no valido con --batch"; else fail "mensaje inesperado: $LAST_STDERR"; fi
if grep -q "pane run" "$HERDR_STUB_LOG"; then fail "no deberia despachar ningun pane"; else pass "ningun pane despachado"; fi

echo ""
echo "[14] --batch + --variant aborta (ambiguo sobre varios issues) sin despachar ningun pane"
run_herdr --batch 872 873 --variant experimento-a
if [ "$LAST_RC" -eq 1 ]; then pass "aborta (rc=$LAST_RC)"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "no es valido con --batch"; then pass "mensaje: --variant no valido con --batch"; else fail "mensaje inesperado: $LAST_STDERR"; fi
if grep -q "pane run" "$HERDR_STUB_LOG"; then fail "no deberia despachar ningun pane"; else pass "ningun pane despachado"; fi

echo ""
echo "[15] --batch + --from-stage aborta (ambiguo sobre varios issues) sin despachar ningun pane"
run_herdr --batch 872 873 --from-stage 2
if [ "$LAST_RC" -eq 1 ]; then pass "aborta (rc=$LAST_RC)"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "no es valido con --batch"; then pass "mensaje: --from-stage no valido con --batch"; else fail "mensaje inesperado: $LAST_STDERR"; fi
if grep -q "pane run" "$HERDR_STUB_LOG"; then fail "no deberia despachar ningun pane"; else pass "ningun pane despachado"; fi

echo ""
echo "[15b] --batch con arbol sucio aborta antes de adquirir o despachar un pane"
git -C "$FAKE_MEFISTO" checkout -q -b feature-sucia-herdr
echo "nota pendiente" > "$FAKE_MEFISTO/nota-pendiente.txt"
run_herdr --batch 872 873
rm -f "$FAKE_MEFISTO/nota-pendiente.txt"
git -C "$FAKE_MEFISTO" checkout -q master 2>/dev/null || git -C "$FAKE_MEFISTO" checkout -q main
if [ "$LAST_RC" -eq 1 ]; then pass "aborta (rc=$LAST_RC)"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -qi "arbol.*limpio"; then pass "el error explica que solo se recupera con arbol limpio"; else fail "mensaje inesperado: $LAST_STDERR"; fi
if [ -s "$HERDR_STUB_LOG" ]; then fail "no deberia adquirir, cerrar ni ejecutar panes -- log: $(cat "$HERDR_STUB_LOG")"; else pass "ningun pane tocado antes del preflight"; fi

echo ""
echo "[15c] --batch limpio recupera y actualiza main antes del dispatch Herdr"
git -C "$PUBLISHER" commit -q --allow-empty -m "origin avanza antes del preflight herdr"
git -C "$PUBLISHER" push -q origin main
EXPECTED_MAIN=$(git -C "$PUBLISHER" rev-parse main)
git -C "$FAKE_MEFISTO" checkout -q -b feature-limpia-herdr
run_herdr --batch 872 873
CURRENT_BRANCH=$(git -C "$FAKE_MEFISTO" rev-parse --abbrev-ref HEAD)
CURRENT_MAIN=$(git -C "$FAKE_MEFISTO" rev-parse main)
if [ "$LAST_RC" -eq 0 ]; then pass "--batch limpio se despacha"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if [ "$CURRENT_BRANCH" = main ] && [ "$CURRENT_MAIN" = "$EXPECTED_MAIN" ]; then pass "recupera a main actualizado"; else fail "rama/base inesperada: HEAD=$CURRENT_BRANCH main=$CURRENT_MAIN esperado=$EXPECTED_MAIN"; fi
if grep -qF "pane run" "$HERDR_STUB_LOG" && grep -qF "mefisto-batch-pipeline.sh 872 873" "$HERDR_STUB_LOG"; then pass "despacha solo despues de recuperar la base"; else fail "no despacho el batch -- log: $(cat "$HERDR_STUB_LOG")"; fi

echo ""
echo "----------------------------------------"
echo "  Combinaciones invalidas: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

# --- [16-17] Reutilizacion de panes -------------------------------------------
#
# Pool con clave de runtime (issue #928 CA-2): las lineas se escriben
# "<pane_id> <runtime>". MEFISTO_RUNTIME=claude se fija explicito en ambos
# bloques para que la seleccion compare contra el mismo runtime que la linea
# del pool, independiente de la autodeteccion por defecto (stub "claude").

echo ""
echo "[16] un pane libre ya registrado del mismo runtime se reutiliza (sin 'pane split')"
mkdir -p "$FAKE_MEFISTO/.mefisto/pipeline"
printf 'w1:p9 claude\n' > "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt"
export MEFISTO_RUNTIME=claude
HERDR_STUB_FREE=true run_herdr --tooling 872
unset MEFISTO_RUNTIME
if [ "$LAST_RC" -eq 0 ]; then pass "corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if grep -q "pane split" "$HERDR_STUB_LOG"; then
    fail "no deberia crear un pane nuevo -- log: $(cat "$HERDR_STUB_LOG")"
else
    pass "no crea un pane nuevo"
fi
if grep -qF "pane run w1:p9" "$HERDR_STUB_LOG"; then
    pass "reutiliza el pane libre registrado (w1:p9)"
else
    fail "no reutilizo el pane registrado -- log: $(cat "$HERDR_STUB_LOG")"
fi

echo ""
echo "[17] un pane registrado pero ocupado se descarta: crea uno nuevo (pane split)"
mkdir -p "$FAKE_MEFISTO/.mefisto/pipeline"
printf 'w1:p9 claude\n' > "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt"
export MEFISTO_RUNTIME=claude
HERDR_STUB_FREE=false run_herdr --tooling 872
unset MEFISTO_RUNTIME
if [ "$LAST_RC" -eq 0 ]; then pass "corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if grep -q "pane split" "$HERDR_STUB_LOG"; then
    pass "crea un pane nuevo porque el registrado esta ocupado"
else
    fail "deberia haber creado un pane nuevo -- log: $(cat "$HERDR_STUB_LOG")"
fi
if grep -qF "pane run w1:p9" "$HERDR_STUB_LOG"; then
    fail "no deberia reusar el pane ocupado -- log: $(cat "$HERDR_STUB_LOG")"
else
    pass "no reutiliza el pane ocupado"
fi

echo ""
echo "----------------------------------------"
echo "  Reutilizacion de panes: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

# --- [18-22] Runtime como clave del pool (issue #928, CA-1..CA-5) ------------

echo ""
echo "[18] CA-1: claude y fake disponibles a la vez sin MEFISTO_RUNTIME -- aborta antes de tocar el pool"
mkdir -p "$FAKE_MEFISTO/.mefisto/pipeline"
printf 'w1:p9 claude\n' > "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt"
POOL_BEFORE=$(cat "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt")
MEFISTO_FAKE_AVAILABLE=1 run_herdr --tooling 872
if [ "$LAST_RC" -eq 1 ]; then pass "aborta (rc=$LAST_RC)"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "No se pudo resolver el runtime activo" \
    && printf '%s' "$LAST_STDERR" | grep -q "varios runtimes disponibles"; then
    pass "mensaje: MEFISTO_RUNTIME_ERROR de runtimes ambiguos"
else
    fail "mensaje inesperado: $LAST_STDERR"
fi
if [ -s "$HERDR_STUB_LOG" ]; then
    fail "no deberia invocar herdr en absoluto -- log: $(cat "$HERDR_STUB_LOG")"
else
    pass "ningun pane split/run/close (el stub de herdr no se invoco)"
fi
POOL_AFTER=$(cat "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt")
if [ "$POOL_BEFORE" = "$POOL_AFTER" ]; then
    pass "el archivo del pool no se modifico"
else
    fail "el pool se modifico -- antes: '$POOL_BEFORE', despues: '$POOL_AFTER'"
fi

echo ""
echo "[19] CA-2: un despacho que crea pane nuevo escribe '<pane_id> <runtime>' en el pool"
rm -f "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt"
export MEFISTO_RUNTIME=fake
run_herdr --tooling 872
unset MEFISTO_RUNTIME
if [ "$LAST_RC" -eq 0 ]; then pass "corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
POOL_CONTENT=$(cat "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt" 2>/dev/null)
if printf '%s\n' "$POOL_CONTENT" | grep -qE '^w1:p[0-9]+ fake$'; then
    pass "el pool guarda la linea con clave '<pane_id> fake'"
else
    fail "el pool no tiene el formato esperado -- contenido: '$POOL_CONTENT'"
fi

echo ""
echo "[20] CA-3: pool con 'w1:p9 claude' libre, despacho fake crea pane nuevo sin tocar el de claude"
printf 'w1:p9 claude\n' > "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt"
export MEFISTO_RUNTIME=fake
HERDR_STUB_FREE=true run_herdr --tooling 872
unset MEFISTO_RUNTIME
if [ "$LAST_RC" -eq 0 ]; then pass "corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if grep -q "pane split" "$HERDR_STUB_LOG"; then
    pass "crea un pane nuevo (el libre registrado es de otro runtime)"
else
    fail "deberia haber creado un pane nuevo -- log: $(cat "$HERDR_STUB_LOG")"
fi
if grep -qF "pane close w1:p9" "$HERDR_STUB_LOG"; then
    fail "no deberia cerrar el pane de otro runtime -- log: $(cat "$HERDR_STUB_LOG")"
else
    pass "no cierra w1:p9 (claude)"
fi
POOL_CONTENT=$(cat "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt")
if printf '%s\n' "$POOL_CONTENT" | grep -qxF "w1:p9 claude"; then
    pass "w1:p9 claude sigue en el pool"
else
    fail "w1:p9 claude ya no esta en el pool -- contenido: '$POOL_CONTENT'"
fi

echo ""
echo "[21] CA-4: la poda de panes libres sobrantes solo considera el mismo runtime"
printf 'w1:p8 fake\nw1:p9 fake\nw1:p7 claude\n' > "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt"
export MEFISTO_RUNTIME=fake
HERDR_STUB_FREE=true run_herdr --tooling 872
unset MEFISTO_RUNTIME
if [ "$LAST_RC" -eq 0 ]; then pass "corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if grep -q "pane split" "$HERDR_STUB_LOG"; then
    fail "no deberia crear un pane nuevo -- deberia reusar w1:p8 -- log: $(cat "$HERDR_STUB_LOG")"
else
    pass "no crea un pane nuevo (reusa uno libre del mismo runtime)"
fi
if grep -qF "pane run w1:p8" "$HERDR_STUB_LOG"; then
    pass "reutiliza w1:p8 (fake)"
else
    fail "no reutilizo w1:p8 -- log: $(cat "$HERDR_STUB_LOG")"
fi
if grep -qF "pane close w1:p9" "$HERDR_STUB_LOG"; then
    pass "cierra el sobrante w1:p9 (fake)"
else
    fail "no cerro el sobrante w1:p9 -- log: $(cat "$HERDR_STUB_LOG")"
fi
if grep -qF "pane close w1:p7" "$HERDR_STUB_LOG"; then
    fail "no deberia cerrar w1:p7 (otro runtime) -- log: $(cat "$HERDR_STUB_LOG")"
else
    pass "no cierra w1:p7 (claude)"
fi
POOL_CONTENT=$(cat "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt")
if printf '%s\n' "$POOL_CONTENT" | grep -qxF "w1:p7 claude"; then
    pass "w1:p7 claude sigue en el pool"
else
    fail "w1:p7 claude salio del pool -- contenido: '$POOL_CONTENT'"
fi
if printf '%s\n' "$POOL_CONTENT" | grep -qxF "w1:p9 fake"; then
    fail "w1:p9 fake deberia haber salido del pool tras cerrarse -- contenido: '$POOL_CONTENT'"
else
    pass "w1:p9 fake ya no esta en el pool"
fi

echo ""
echo "[22] CA-5: una linea legacy sin clave de runtime se descarta del pool sin cerrar su pane"
printf 'w1:p9\n' > "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt"
run_herdr --tooling 872
if [ "$LAST_RC" -eq 0 ]; then pass "corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if grep -qF "pane close w1:p9" "$HERDR_STUB_LOG"; then
    fail "no deberia cerrar la linea legacy -- log: $(cat "$HERDR_STUB_LOG")"
else
    pass "no cierra w1:p9 (legacy, sin clave)"
fi
POOL_CONTENT=$(cat "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt")
if printf '%s\n' "$POOL_CONTENT" | grep -qxF "w1:p9"; then
    fail "la linea legacy deberia haber salido del pool -- contenido: '$POOL_CONTENT'"
else
    pass "la linea legacy salio del pool"
fi

echo ""
echo "----------------------------------------"
echo "  Runtime como clave del pool: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

# --- [24-26] Flags que se consumen o se reenvian tal cual (CA-3 de #872) -----
#
# --from-stage y --variant viajan, y su valor tiene que aparecer en la linea que se teclea en
# el pane; --if-exists y --attach abortan sin despachar. Sin estos
# casos, un flag mal ruteado se descartaria en silencio -- exactamente el
# defecto que #709/#711 corrigieron para --models/--variant.

echo ""
echo "[24] --if-exists y --attach abortan con un error explicito, sin despachar"
for retired in "--tooling 872 --if-exists replace" "--attach"; do
    # shellcheck disable=SC2086
    run_herdr $retired
    if [ "$LAST_RC" -eq 1 ]; then pass "$retired: aborta (rc=$LAST_RC)"; else fail "$retired: deberia abortar (rc=$LAST_RC)"; fi
    if printf '%s' "$LAST_STDERR" | grep -q -- "--attach e --if-exists ya no existen"; then pass "$retired: el mensaje nombra los dos flags"; else fail "$retired: mensaje inesperado: $LAST_STDERR"; fi
    if grep -q "pane run" "$HERDR_STUB_LOG"; then fail "$retired: no deberia despachar ningun pane"; else pass "$retired: ningun pane despachado"; fi
done

echo ""
echo "[25] --from-stage y --variant se reenvian con su valor al sub-pipeline canonico"
run_herdr --tooling 872 --from-stage 2 --variant experimento-a
if [ "$LAST_RC" -eq 0 ]; then pass "corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if grep -qF -- "mefisto-tooling-pipeline.sh 872 --from-stage 2" "$HERDR_STUB_LOG"; then
    pass "--from-stage 2 llega al sub-pipeline en la posicion esperada"
else
    fail "--from-stage no llego al sub-pipeline -- log: $(cat "$HERDR_STUB_LOG")"
fi
if grep -qF -- "--variant experimento-a" "$HERDR_STUB_LOG"; then
    pass "--variant llega al sub-pipeline con su label"
else
    fail "--variant no llego al sub-pipeline -- log: $(cat "$HERDR_STUB_LOG")"
fi
if grep -qF "experimento-a" "$HERDR_STUB_LOG" && grep -qF -- "--title" "$HERDR_STUB_LOG"; then
    pass "el titulo del pane distingue la variante"
else
    fail "el titulo del pane no distingue la variante -- log: $(cat "$HERDR_STUB_LOG")"
fi

echo ""
echo "[26] --from-stage con valor no numerico aborta antes de despachar"
run_herdr --tooling 872 --from-stage dos
if [ "$LAST_RC" -eq 1 ]; then pass "aborta (rc=$LAST_RC)"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "numero entero"; then pass "mensaje: debe ser un numero entero"; else fail "mensaje inesperado: $LAST_STDERR"; fi
if grep -q "pane run" "$HERDR_STUB_LOG"; then fail "no deberia despachar ningun pane"; else pass "ningun pane despachado"; fi

echo ""
echo "----------------------------------------"
echo "  Flags consumidos y reenviados: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

# --- [27] Guard de contexto herdr (CA-5 de #872) -----------------------------

echo ""
echo "[27] fuera de un pane herdr (HERDR_ENV != 1) aborta remitiendo al modo desacoplado"
: > "$HERDR_STUB_LOG"
echo 0 > "$HERDR_STUB_COUNTER"
(
    cd "$FAKE_MEFISTO" || exit 99
    env -u MEFISTO_UI -u HERDR_ENV \
        -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR \
        -u MEFISTO_REPO_ROOT -u MEFISTO_PROJECT_NAME -u MEFISTO_REPO_SLUG \
        PATH="$FAKE_BIN:$PATH" \
        HERDR_PANE_ID="w1:p0" HERDR_WORKSPACE_ID="w1" \
        HERDR_STUB_LOG="$HERDR_STUB_LOG" HERDR_STUB_COUNTER="$HERDR_STUB_COUNTER" \
        "$HERDR_SCRIPT" --tooling 872
) </dev/null >"$TMP_DIR/stdout" 2>"$TMP_DIR/stderr"
LAST_RC=$?
LAST_STDERR=$(cat "$TMP_DIR/stderr")
if [ "$LAST_RC" -eq 1 ]; then pass "aborta (rc=$LAST_RC)"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "mefisto-launch-pipeline.sh sin MEFISTO_UI=herdr"; then pass "el remedio nombra mefisto-launch-pipeline.sh sin MEFISTO_UI=herdr"; else fail "mensaje inesperado: $LAST_STDERR"; fi
if grep -q "pane run" "$HERDR_STUB_LOG"; then fail "no deberia despachar ningun pane"; else pass "ningun pane despachado"; fi

# --- [28] Guard estatico del canonico (CA-4 de #872, CA-6 de #928) ----------
#
# Contraparte del bloque [B] de test-batch-runtime.sh, sobre el archivo REAL
# (no la copia del fixture). La ruta legacy del estado ya la fija el bloque
# [I] de test-tooling-state-paths.sh; aqui se cierra la parte de CA-4 que no
# cubre nadie: que ningun comentario siga hablando de `claude -p` como si el
# runner fuera siempre Claude Code (MEF-ADR-0049), y que el estado se resuelva
# con mefisto_state_path en vez de componerse a mano.

CANON_HERDR="$REPO_ROOT/src/internal/scripts/mefisto-herdr-pipeline.sh"

echo ""
echo "[28] el canonico no menciona 'claude -p' y resuelve su estado con mefisto_state_path"
if grep -qF 'claude -p' "$CANON_HERDR"; then
    fail "todavia menciona 'claude -p' (el runner depende del runtime activo)"
    grep -nF 'claude -p' "$CANON_HERDR"
else
    pass "cero menciones de 'claude -p' (codigo y comentarios)"
fi
if grep -qF 'LOG_DIR_ABS="$(mefisto_state_path "logs")"' "$CANON_HERDR"; then
    pass "LOG_DIR_ABS resuelve con mefisto_state_path"
else
    fail "LOG_DIR_ABS ya no resuelve con mefisto_state_path"
fi
if grep -qF 'PANES_STATE="$(mefisto_state_path "herdr-report-panes.txt")"' "$CANON_HERDR"; then
    pass "el registro de panes resuelve con mefisto_state_path"
else
    fail "el registro de panes ya no resuelve con mefisto_state_path"
fi
LEGACY_CODE_REFS=$(grep -vE '^\s*#' "$CANON_HERDR" | grep -c '\.claude/pipeline' || true)
if [ "$LEGACY_CODE_REFS" -eq 0 ]; then
    pass "cero lineas de codigo con '.claude/pipeline'"
else
    fail "$LEGACY_CODE_REFS linea(s) de codigo con '.claude/pipeline'"
fi
# La unica referencia a .claude/scripts que sobrevive en CODIGO es la
# invocacion del visor, que todavia vive ahi (#878 neutralizo su fuente de
# datos, no su ubicacion) -- mismo caso que mefisto-launch-pipeline.sh tras
# #871. Fijar el numero exacto convierte cualquier ruta legacy nueva en un
# fallo, sin pedir lo imposible mientras el visor no se mueva.
SCRIPTS_CODE_REFS=$(grep -vE '^\s*#' "$CANON_HERDR" | grep -c '\.claude/scripts' || true)
VIEWER_CODE_REFS=$(grep -vE '^\s*#' "$CANON_HERDR" | grep -c '\.claude/scripts/mefisto-stream-watch\.sh' || true)
if [ "$SCRIPTS_CODE_REFS" -eq "$VIEWER_CODE_REFS" ] && [ "$VIEWER_CODE_REFS" -gt 0 ]; then
    pass "las $VIEWER_CODE_REFS referencias a .claude/scripts en codigo son solo el visor"
else
    fail "hay referencias a .claude/scripts en codigo que no son el visor ($SCRIPTS_CODE_REFS totales, $VIEWER_CODE_REFS del visor)"
    grep -vE '^\s*#' "$CANON_HERDR" | grep -n '\.claude/scripts'
fi
if grep -qF 'dispatch_to_pane "$title" "$issue" "$SCRIPT_DIR/mefisto-tooling-pipeline.sh"' "$CANON_HERDR" \
   && grep -qF 'dispatch_to_pane "mefisto-batch ${issues_csv}" "$issues_csv" "$SCRIPT_DIR/mefisto-batch-pipeline.sh"' "$CANON_HERDR"; then
    pass "tooling y batch se despachan a los siblings canonicos via SCRIPT_DIR (CA-2)"
else
    fail "tooling/batch ya no se despachan a los siblings canonicos via SCRIPT_DIR"
fi
# CA-6 (issue #928): el runtime de esta capa neutral se resuelve siempre con
# mefisto_resolve_runtime -- un default literal incrustado aqui (p. ej.
# "${MEFISTO_RUNTIME:-claude}") degradaria en silencio a un unico runtime
# fijo, exactamente lo que el pool con clave de runtime deja de tolerar.
if grep -qE ':-claude' "$CANON_HERDR"; then
    fail "el canonico incrusta un default literal de runtime"
    grep -nE ':-claude' "$CANON_HERDR"
else
    pass "cero defaults literales de runtime (':-claude')"
fi
if grep -qF 'source "$(cd "$SCRIPT_DIR/../../runtime/lib" && pwd)/mefisto-runtime.sh"' "$CANON_HERDR" \
   && grep -qF 'runtime=$(mefisto_resolve_runtime)' "$CANON_HERDR"; then
    pass "acquire_report_pane resuelve el runtime con mefisto_resolve_runtime"
else
    fail "acquire_report_pane ya no resuelve el runtime con mefisto_resolve_runtime"
fi

echo ""
echo "----------------------------------------"
echo "  Guards de contexto y del canonico: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

# --- [29] tail -f del .report.log dentro de --_pane-runner (CA-1/2/3 de #926) -
#
# Corre el runner interno directamente (sin pasar por el shim ni por herdr
# real), sin HERDR_PANE_ID en el entorno -- salta los "herdr pane rename" y
# aisla el chequeo del tail -f del resto del contrato de panes. El comando
# falso imprime una linea, duerme 3s e imprime otra: mientras duerme, la
# primera linea ya debe estar en la captura del stdout del runner (CA-1). Al
# terminar, ambas lineas aparecen exactamente una vez (no se duplican con un
# cat/tail final, que CA-2 elimina) y el rc devuelto es el del comando falso.

FAKE_CMD="$TMP_DIR/fake-cmd.sh"
cat > "$FAKE_CMD" <<'FAKECMD'
#!/usr/bin/env bash
echo "linea-uno-del-comando-falso"
sleep 3
echo "linea-dos-del-comando-falso"
exit "${1:-0}"
FAKECMD
chmod +x "$FAKE_CMD"

# run_pane_runner_live <exit_code_esperado>
#
# Lanza --_pane-runner en background (capturando su stdout+stderr a un
# archivo), sondea hasta 2.5s -- bien antes de los 3s que duerme el comando
# falso -- esperando ver la primera linea ya en la captura, y solo entonces
# espera a que el runner termine para verificar el resto.
run_pane_runner_live() {
    local expected_rc="$1"
    local capture="$TMP_DIR/pane-runner-stdout-$expected_rc.log"
    (
        cd "$FAKE_MEFISTO" || exit 99
        env -u MEFISTO_UI -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID \
            -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR \
            -u MEFISTO_REPO_ROOT -u MEFISTO_PROJECT_NAME -u MEFISTO_REPO_SLUG \
            PATH="$FAKE_BIN:$PATH" \
            "$FAKE_MEFISTO/src/internal/scripts/mefisto-herdr-pipeline.sh" \
            --_pane-runner --title t --issues 999999 -- "$FAKE_CMD" "$expected_rc"
    ) </dev/null >"$capture" 2>&1 &
    local runner_pid=$!

    local waited=0 seen=false
    while [ "$waited" -lt 25 ]; do
        if grep -qF "linea-uno-del-comando-falso" "$capture" 2>/dev/null; then
            seen=true
            break
        fi
        sleep 0.1
        waited=$((waited + 1))
    done
    if [ "$seen" = "true" ] && kill -0 "$runner_pid" 2>/dev/null; then
        pass "(rc esperado $expected_rc) la primera linea aparece en vivo antes de que el comando falso termine"
    else
        fail "(rc esperado $expected_rc) la primera linea no aparecio en vivo a tiempo -- captura: $(cat "$capture" 2>/dev/null)"
    fi

    local runner_rc=0
    wait "$runner_pid" || runner_rc=$?
    if [ "$runner_rc" -eq "$expected_rc" ]; then
        pass "el rc devuelto es el del comando falso ($expected_rc)"
    else
        fail "rc esperado $expected_rc, obtenido $runner_rc"
    fi

    local count_uno count_dos
    count_uno=$(grep -cF "linea-uno-del-comando-falso" "$capture")
    count_dos=$(grep -cF "linea-dos-del-comando-falso" "$capture")
    if [ "$count_uno" -eq 1 ] && [ "$count_dos" -eq 1 ]; then
        pass "ambas lineas aparecen exactamente una vez en la captura final"
    else
        fail "conteo inesperado (linea-uno=$count_uno, linea-dos=$count_dos) -- captura: $(cat "$capture")"
    fi

    # El pane es uno solo: la marca del visor y las lineas del reporte tienen
    # que convivir en la misma captura (es lo que pide el issue #926). De paso
    # el chequeo del "No such file" delata que el stub del visor dejo de
    # resolverse -- ahi el bloque estaria midiendo el tail contra un pane
    # vacio en vez de contra el visor.
    if grep -qF "visor-stub-arrancado" "$capture" \
        && ! grep -qF "No such file or directory" "$capture"; then
        pass "el visor y el tail comparten el mismo pane (marca del visor presente, sin errores de arranque)"
    else
        fail "el visor no arranco junto al tail -- captura: $(cat "$capture")"
    fi

    # CA-3: ni la corrida normal ni el trap dejan un `tail -f` del reporte
    # vivo. El snapshot de ps se vuelca a un archivo ANTES de grepearlo para
    # que el propio grep (que lleva el patron en su cmdline) no se autodelate.
    local ps_snapshot="$TMP_DIR/ps-snapshot-$expected_rc.txt"
    # -ww: sin el, ps trunca la cmdline a 80 columnas y la ruta larga del
    # reporte (bajo /var/folders/... o /tmp/...) se cortaria justo antes del
    # patron -- el chequeo pasaria siempre, incluso con un tail huerfano.
    ps -Aww -o args= > "$ps_snapshot" 2>/dev/null || true
    if grep -qF "$FAKE_MEFISTO/.mefisto/pipeline/logs" "$ps_snapshot"; then
        fail "quedo un proceso vivo sobre el .report.log tras la corrida: $(grep -F "$FAKE_MEFISTO/.mefisto/pipeline/logs" "$ps_snapshot")"
    else
        pass "no queda ningun tail -f del .report.log vivo tras la corrida"
    fi

    if [ "$expected_rc" -eq 0 ]; then
        if grep -q "pipeline terminado OK" "$capture"; then
            pass "banner OK impreso"
        else
            fail "no se imprimio el banner OK -- captura: $(cat "$capture")"
        fi
    else
        if grep -qF "pipeline FALLO (exit $expected_rc)" "$capture"; then
            pass "banner de fallo impreso con el exit code correcto"
        else
            fail "no se imprimio el banner de fallo con exit $expected_rc -- captura: $(cat "$capture")"
        fi
    fi
}

echo ""
echo "[29a] --_pane-runner con un comando falso que termina exit 0"
run_pane_runner_live 0

echo ""
echo "[29b] --_pane-runner con un comando falso que termina exit 7"
run_pane_runner_live 7

echo ""
echo "----------------------------------------"
echo "  tail -f en vivo del reporte: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

# --- [30-33] Confirmacion de arranque del runner (issue #1563, porte #1571) -
#
# Mismo mecanismo que scripts/tests/test-herdr-dispatch-confirm.sh (lado
# publicado): el stub de "pane run" toca el --started-marker de la cmdline
# salvo que el pane destino este en HERDR_STUB_NEVER_CONFIRM (simula el shell
# atascado que nunca ejecuto --_pane-runner, certificacion v0.38.2).
# HERDR_DISPATCH_CONFIRM_TIMEOUT se fija en 1s para no alargar la suite. Cada
# bloque limpia el pool antes de correr, para que acquire_report_pane siempre
# arranque en w1:p1 dentro de ESA corrida (run_herdr reinicia el contador del
# stub a 0 en cada llamada).

echo ""
echo "[30] arranque confirmado al primer intento: un solo pane split/run, sin aviso de reintento"
rm -f "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt"
export MEFISTO_RUNTIME=claude
export HERDR_DISPATCH_CONFIRM_TIMEOUT=1
unset HERDR_STUB_NEVER_CONFIRM
run_herdr --tooling 872
unset MEFISTO_RUNTIME HERDR_DISPATCH_CONFIRM_TIMEOUT
if [ "$LAST_RC" -eq 0 ]; then pass "exit code 0"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if [ "$(grep -c '^herdr pane split' "$HERDR_STUB_LOG")" -eq 1 ]; then pass "un solo pane split (el pane de ejecucion)"; else fail "cantidad de pane split inesperada -- log: $(cat "$HERDR_STUB_LOG")"; fi
if [ "$(grep -c '^herdr pane run' "$HERDR_STUB_LOG")" -eq 1 ]; then pass "un solo pane run (sin reintento)"; else fail "cantidad de pane run inesperada -- log: $(cat "$HERDR_STUB_LOG")"; fi
if printf '%s' "$LAST_STDERR" | grep -qF "corriendo en el pane w1:p1"; then pass "mensaje de exito nombra el pane"; else fail "mensaje inesperado: $LAST_STDERR"; fi
if printf '%s' "$LAST_STDERR" | grep -q "Reintentando"; then fail "no deberia avisar reintento"; else pass "sin aviso de reintento"; fi

echo ""
echo "[31] fallo del primer arranque, reintento exitoso en un pane nuevo"
rm -f "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt"
export MEFISTO_RUNTIME=claude
export HERDR_DISPATCH_CONFIRM_TIMEOUT=1
export HERDR_STUB_NEVER_CONFIRM="w1:p1"
run_herdr --tooling 872
unset MEFISTO_RUNTIME HERDR_DISPATCH_CONFIRM_TIMEOUT HERDR_STUB_NEVER_CONFIRM
if [ "$LAST_RC" -eq 0 ]; then pass "exit code 0 (el reintento confirma)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if [ "$(grep -c '^herdr pane split' "$HERDR_STUB_LOG")" -eq 2 ]; then pass "dos pane split: pane sospechoso + reintento nuevo"; else fail "cantidad de pane split inesperada -- log: $(cat "$HERDR_STUB_LOG")"; fi
if [ "$(grep -c '^herdr pane run' "$HERDR_STUB_LOG")" -eq 2 ]; then pass "dos pane run: original + reintento"; else fail "cantidad de pane run inesperada -- log: $(cat "$HERDR_STUB_LOG")"; fi
if [ "$(grep -c 'pane run w1:p1' "$HERDR_STUB_LOG")" -eq 1 ]; then pass "el pane sospechoso solo recibe un pane run"; else fail "el pane sospechoso recibio mas de un pane run -- log: $(cat "$HERDR_STUB_LOG")"; fi
if grep -qF "pane run w1:p2" "$HERDR_STUB_LOG"; then pass "el reintento escribe en un pane nuevo (w1:p2)"; else fail "el reintento no escribio en w1:p2 -- log: $(cat "$HERDR_STUB_LOG")"; fi
if printf '%s' "$LAST_STDERR" | grep -q "El pane w1:p1 no confirmo el arranque"; then pass "el aviso nombra el pane sospechoso"; else fail "mensaje inesperado: $LAST_STDERR"; fi
if printf '%s' "$LAST_STDERR" | grep -qF "corriendo en el pane w1:p2"; then pass "el exito final nombra el pane de reintento"; else fail "mensaje inesperado: $LAST_STDERR"; fi
if printf '%s' "$LAST_STDERR" | grep -qF "reintento tras un arranque no confirmado en w1:p1"; then pass "el exito final documenta el reintento"; else fail "mensaje inesperado: $LAST_STDERR"; fi
if grep -qx "w1:p2 claude" "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt"; then pass "el pane de reintento queda en el pool con el runtime de la corrida"; else fail "pool inesperado: $(cat "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt")"; fi

echo ""
echo "[32] fallo doble: ni el pane original ni el de reintento confirman"
rm -f "$FAKE_MEFISTO/.mefisto/pipeline/herdr-report-panes.txt"
export MEFISTO_RUNTIME=claude
export HERDR_DISPATCH_CONFIRM_TIMEOUT=1
export HERDR_STUB_NEVER_CONFIRM="w1:p1 w1:p2"
run_herdr --tooling 872
unset MEFISTO_RUNTIME HERDR_DISPATCH_CONFIRM_TIMEOUT HERDR_STUB_NEVER_CONFIRM
if [ "$LAST_RC" -ne 0 ]; then pass "exit code distinto de 0"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if [ "$(grep -c '^herdr pane split' "$HERDR_STUB_LOG")" -eq 2 ]; then pass "dos pane split (sin un tercer intento)"; else fail "cantidad de pane split inesperada -- log: $(cat "$HERDR_STUB_LOG")"; fi
if [ "$(grep -c '^herdr pane run' "$HERDR_STUB_LOG")" -eq 2 ]; then pass "dos pane run (sin un tercer intento)"; else fail "cantidad de pane run inesperada -- log: $(cat "$HERDR_STUB_LOG")"; fi
if printf '%s' "$LAST_STDERR" | grep -qF "w1:p1"; then pass "el mensaje final nombra el pane original"; else fail "mensaje inesperado: $LAST_STDERR"; fi
if printf '%s' "$LAST_STDERR" | grep -qF "w1:p2"; then pass "el mensaje final nombra el pane de reintento"; else fail "mensaje inesperado: $LAST_STDERR"; fi
if printf '%s' "$LAST_STDERR" | grep -q "Cierra ambos paneles"; then pass "el mensaje sugiere cerrar los paneles"; else fail "mensaje inesperado: $LAST_STDERR"; fi
if printf '%s' "$LAST_STDERR" | grep -q "corriendo en el pane"; then fail "no deberia imprimir el mensaje de exito"; else pass "no imprime el mensaje de exito"; fi

echo ""
echo "[33] runner tardio: un --started-marker ya reclamado hace que cmd_pane_runner aborte sin lanzar el sub-pipeline"
LATE_MARKER="$TMP_DIR/late/herdr-dispatch-late.started"
LATE_SENTINEL="$TMP_DIR/late/sub-pipeline-ran"
mkdir -p "$TMP_DIR/late"
printf 'abandonado\n' > "$LATE_MARKER"
(
    cd "$FAKE_MEFISTO" || exit 99
    env -u MEFISTO_UI -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID \
        -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR \
        -u MEFISTO_REPO_ROOT -u MEFISTO_PROJECT_NAME -u MEFISTO_REPO_SLUG \
        PATH="$FAKE_BIN:$PATH" \
        "$FAKE_MEFISTO/src/internal/scripts/mefisto-herdr-pipeline.sh" \
        --_pane-runner --title "late #872" --started-marker "$LATE_MARKER" -- touch "$LATE_SENTINEL"
) </dev/null >"$TMP_DIR/stdout" 2>"$TMP_DIR/stderr"
LAST_RC=$?
LAST_STDERR=$(cat "$TMP_DIR/stderr")
if [ "$LAST_RC" -ne 0 ]; then pass "exit code distinto de 0"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "ya reclamado por el despachador"; then pass "el mensaje explica el marcador reclamado"; else fail "mensaje inesperado: $LAST_STDERR"; fi
if [ -e "$LATE_SENTINEL" ]; then fail "el sub-pipeline no debe lanzarse sobre un marcador reclamado"; else pass "el sub-pipeline no se lanzo"; fi

echo ""
echo "----------------------------------------"
echo "  Confirmacion de arranque del runner: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

# --- [35-37] Issue #2284: delegacion del lanzador por runtime + guard de pane heredado ---
# El lanzador corre en Node: el fixture lleva su .mts con lo que importa, y node en el
# PATH recortado. Su modo desacoplado lo cubre .claude/scripts/tests/mefisto-launch-pipeline.test.mts.
WRAPPER="$FAKE_MEFISTO/src/internal/scripts/mefisto-launch-pipeline.sh"
cp "$REPO_ROOT/src/internal/scripts/mefisto-launch-pipeline.sh" "$WRAPPER"
chmod +x "$WRAPPER"
cp "$REPO_ROOT/src/internal/scripts/mefisto-launch-pipeline.mts" "$FAKE_MEFISTO/src/internal/scripts/"
cp "$REPO_ROOT"/src/internal/scripts/lib/*.mts "$FAKE_MEFISTO/src/internal/scripts/lib/"
mkdir -p "$FAKE_MEFISTO/scripts"
cp -R "$REPO_ROOT/scripts/lib" "$FAKE_MEFISTO/scripts/"
ln -sf "$(command -v node)" "$FAKE_BIN/node"
run_wrapper() {
    : > "$HERDR_STUB_LOG"; echo 0 > "$HERDR_STUB_COUNTER"
    (
        cd "$FAKE_MEFISTO" || exit 99
        env -u MEFISTO_UI -u MEFISTO_RUNTIME \
            -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR \
            -u MEFISTO_REPO_ROOT -u MEFISTO_PROJECT_NAME -u MEFISTO_REPO_SLUG \
            PATH="$FAKE_BIN:/usr/bin:/bin" \
            HERDR_ENV=1 HERDR_PANE_ID="w1:p0" HERDR_WORKSPACE_ID="w1" \
            HERDR_STUB_LOG="$HERDR_STUB_LOG" HERDR_STUB_COUNTER="$HERDR_STUB_COUNTER" \
            HERDR_STUB_OWNER_PID="${HERDR_STUB_OWNER_PID-$$}" \
            "$@"
    ) </dev/null >"$TMP_DIR/stdout" 2>"$TMP_DIR/stderr"
    LAST_RC=$?
    LAST_STDERR=$(cat "$TMP_DIR/stderr")
}
no_pane_calls() { ! grep -qE "pane (split|run|close)" "$HERDR_STUB_LOG"; }

echo ""
echo "[35] CA-2 (#2284): runtime fake conserva el split a la derecha de HERDR_PANE_ID"
run_wrapper MEFISTO_RUNTIME=fake "$WRAPPER" --tooling 2284
if grep -qF "pane split --pane w1:p0 --direction right" "$HERDR_STUB_LOG"; then pass "split a la derecha de w1:p0"; else fail "sin split esperado -- log: $(cat "$HERDR_STUB_LOG")"; fi

echo ""
echo "[36] CA-3 (#2284): MEFISTO_UI=herdr explicito se respeta aunque el runtime sea claude"
run_wrapper MEFISTO_RUNTIME=claude MEFISTO_UI=herdr "$WRAPPER" --tooling 2284
if grep -qE "pane (split|run)" "$HERDR_STUB_LOG"; then pass "MEFISTO_UI=herdr gana"; else fail "no uso herdr -- log: $(cat "$HERDR_STUB_LOG") err: $LAST_STDERR"; fi
run_wrapper MEFISTO_RUNTIME=claude MEFISTO_UI=herdr HERDR_ENV=0 "$WRAPPER" --tooling 2284
if [ "$LAST_RC" -eq 1 ] && printf '%s' "$LAST_STDERR" | grep -q "No estas dentro de un pane de herdr"; then pass "MEFISTO_UI=herdr fuera de herdr aborta con mensaje claro"; else fail "rc=$LAST_RC err: $LAST_STDERR"; fi
if no_pane_calls; then pass "MEFISTO_UI=herdr fuera de herdr: cero pane split|run|close"; else fail "toco panes -- log: $(cat "$HERDR_STUB_LOG")"; fi

echo ""
echo "[37] CA-4 (#2284): pane heredado/ajeno aborta sin tocar panes"
HERDR_STUB_OWNER_PID=999999 run_wrapper MEFISTO_RUNTIME=fake "$WRAPPER" --tooling 2284
if [ "$LAST_RC" -ne 0 ]; then pass "exit != 0"; else fail "deberia abortar"; fi
if printf '%s' "$LAST_STDERR" | grep -q "heredado"; then pass "mensaje del guard"; else fail "mensaje inesperado: $LAST_STDERR"; fi
if no_pane_calls; then pass "cero pane split|run|close"; else fail "toco panes -- log: $(cat "$HERDR_STUB_LOG")"; fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -eq 0 ]
