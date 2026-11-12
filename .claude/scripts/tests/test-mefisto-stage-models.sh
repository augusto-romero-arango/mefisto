#!/usr/bin/env bash
# test-mefisto-stage-models.sh -- Tests del mecanismo de asignacion de modelo
# por stage (--models, issue #709) en .claude/scripts/_mefisto-common.sh y
# .claude/scripts/mefisto-herdr-pipeline.sh. El reenvio de --models en el modo
# desacoplado de mefisto-launch-pipeline.mts lo prueba mefisto-launch-pipeline.test.mts,
# y el cableado de --models y del effort por agente en el pipeline interno de
# tooling, mefisto-tooling-pipeline.test.mts.
#
# Contraparte interna de scripts/tests/test-stage-models.sh (issue #708, lado
# publicado): mismo contrato de UX, verificado sobre las copias internas --
# MEF-ADR-0019 prohibe compartir codigo entre los dos lados, asi que este
# archivo no importa nada del publicado.
#
# Cubre:
#   parse_stage_models/resolve_stage_model/format_stage_models_for_log
#       (bloques 1-10) -- mismos casos que el homologo publicado: spec vacio
#       (CA-2: sin --models, nada cambia), N entradas, id de modelo completo
#       con caracteres especiales (sin allowlist propia), las tres formas de
#       entrada malformada (CA-1), resolve sin match/sin mapa, y el formato
#       de auditoria (CA-4).
#   mefisto-herdr-pipeline.sh (bloques 20-24) -- la otra mitad de CA-3: dentro
#       de un pane herdr el valor viaja crudo (sin las comillas que solo
#       sirven al `bash -c` del modo desacoplado), sobrevive un id de modelo
#       con caracteres de glob, y el mismo rechazo explicito en --batch.
#
# Uso: .claude/scripts/tests/test-mefisto-stage-models.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# Las funciones viven en _mefisto-common.sh, sourcearlo solo las define.
# shellcheck source=/dev/null
source "$REPO_ROOT/.claude/scripts/_mefisto-common.sh" 2>/dev/null

echo "[1] parse_stage_models: spec vacio deja el mapa vacio y no aborta (sin --models, nada cambia)"
if parse_stage_models ""; then pass "spec vacio retorna 0"; else fail "spec vacio no deberia abortar"; fi
if [ -z "$MEFISTO_STAGE_MODELS" ]; then pass "mapa vacio"; else fail "mapa deberia quedar vacio (obtenido '$MEFISTO_STAGE_MODELS')"; fi

echo ""
echo "[2] parse_stage_models: spec valido de una entrada"
if parse_stage_models "reviewer=opus"; then pass "una entrada retorna 0"; else fail "una entrada valida no deberia abortar"; fi
if [ "$MEFISTO_STAGE_MODELS" = "reviewer=opus" ]; then pass "mapa contiene la entrada"; else fail "mapa incorrecto: '$MEFISTO_STAGE_MODELS'"; fi

echo ""
echo "[3] parse_stage_models: spec valido de N entradas, separadas por coma"
if parse_stage_models "writer=sonnet,reviewer=opus"; then pass "dos entradas retorna 0"; else fail "dos entradas validas no deberia abortar"; fi
R=$(resolve_stage_model "writer" "default-no-usado")
if [ "$R" = "sonnet" ]; then pass "writer resuelve a sonnet"; else fail "writer deberia resolver a sonnet (obtenido '$R')"; fi
R=$(resolve_stage_model "reviewer" "default-no-usado")
if [ "$R" = "opus" ]; then pass "reviewer resuelve a opus"; else fail "reviewer deberia resolver a opus (obtenido '$R')"; fi

echo ""
echo "[4] parse_stage_models: id de modelo completo con caracteres especiales (sin allowlist de nombres)"
if parse_stage_models 'writer=claude-opus-5[1m]'; then pass "id completo con [] retorna 0"; else fail "un id de modelo completo no deberia abortar (sin allowlist propia)"; fi
R=$(resolve_stage_model "writer" "default-no-usado")
if [ "$R" = "claude-opus-5[1m]" ]; then pass "resuelve el id completo tal cual"; else fail "deberia resolver 'claude-opus-5[1m]' (obtenido '$R')"; fi

echo ""
echo "[5] parse_stage_models: entrada sin '=' aborta con mensaje claro"
if parse_stage_models "reviewer-opus"; then fail "entrada sin '=' no deberia retornar 0"; else pass "entrada sin '=' aborta"; fi
if printf '%s' "$MEFISTO_STAGE_MODELS_ERROR" | grep -q "reviewer-opus"; then pass "el error nombra la entrada malformada"; else fail "MEFISTO_STAGE_MODELS_ERROR no menciona la entrada: '$MEFISTO_STAGE_MODELS_ERROR'"; fi

echo ""
echo "[6] parse_stage_models: clave o valor vacio aborta"
if parse_stage_models "=opus"; then fail "clave vacia no deberia retornar 0"; else pass "clave vacia aborta"; fi
if parse_stage_models "reviewer="; then fail "valor vacio no deberia retornar 0"; else pass "valor vacio aborta"; fi

echo ""
echo "[7] parse_stage_models: agente repetido aborta"
if parse_stage_models "writer=sonnet,writer=opus"; then fail "agente repetido no deberia retornar 0"; else pass "agente repetido aborta"; fi
if printf '%s' "$MEFISTO_STAGE_MODELS_ERROR" | grep -q "writer"; then pass "el error nombra el agente repetido"; else fail "MEFISTO_STAGE_MODELS_ERROR no menciona 'writer': '$MEFISTO_STAGE_MODELS_ERROR'"; fi

echo ""
echo "[8] resolve_stage_model: sin match en el mapa, cae al default"
parse_stage_models "reviewer=opus" >/dev/null
R=$(resolve_stage_model "writer" "sonnet")
if [ "$R" = "sonnet" ]; then pass "writer sin override resuelve al default"; else fail "deberia caer al default 'sonnet' (obtenido '$R')"; fi

echo ""
echo "[9] resolve_stage_model: sin --models (mapa vacio), siempre el default -- byte a byte el comportamiento previo al flag"
parse_stage_models "" >/dev/null
R=$(resolve_stage_model "reviewer" "opus")
if [ "$R" = "opus" ]; then pass "reviewer sin mapa resuelve al default 'opus'"; else fail "deberia resolver al default (obtenido '$R')"; fi
R=$(resolve_stage_model "writer" "sonnet")
if [ "$R" = "sonnet" ]; then pass "writer sin mapa resuelve al default 'sonnet'"; else fail "deberia resolver al default (obtenido '$R')"; fi

echo ""
echo "[10] format_stage_models_for_log: vacio sin mapa, formateado con mapa"
parse_stage_models "" >/dev/null
R=$(format_stage_models_for_log)
if [ -z "$R" ]; then pass "sin mapa, formato vacio"; else fail "deberia ser vacio sin --models (obtenido '$R')"; fi
parse_stage_models "writer=sonnet,reviewer=opus" >/dev/null
R=$(format_stage_models_for_log)
if [ "$R" = "writer=sonnet, reviewer=opus" ]; then pass "formato de auditoria: 'writer=sonnet, reviewer=opus'"; else fail "formato incorrecto: '$R'"; fi

echo ""
echo "----------------------------------------"
echo "  _mefisto-common.sh: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

# --- mefisto-herdr-pipeline.sh: reenvio/rechazo ------------------------------
#
# Mismo arnes que test-harness-version.sh: fixture con .claude-plugin/plugin.json
# (assert_in_mefisto lo exige) y copias de los scripts reales bajo
# .claude/scripts/, mas un stub de herdr en PATH que solo registra la
# invocacion sin tocar un servidor real.

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
cp "$REPO_ROOT/src/internal/scripts/lib/_mefisto-common.sh" "$FAKE_MEFISTO/src/internal/scripts/lib/_mefisto-common.sh"
cp "$REPO_ROOT/.claude/scripts/_mefisto-common.sh" "$FAKE_MEFISTO/.claude/scripts/_mefisto-common.sh"
cp "$REPO_ROOT/src/internal/scripts/lib/mefisto-state.sh" "$FAKE_MEFISTO/src/internal/scripts/lib/mefisto-state.sh"
cp -R "$REPO_ROOT/src/runtime" "$FAKE_MEFISTO/src/runtime"
cp "$REPO_ROOT/.claude/scripts/mefisto-herdr-pipeline.sh" "$FAKE_MEFISTO/.claude/scripts/mefisto-herdr-pipeline.sh"
cp "$REPO_ROOT/src/internal/scripts/mefisto-herdr-pipeline.sh" "$FAKE_MEFISTO/src/internal/scripts/mefisto-herdr-pipeline.sh"
# El lanzador herdr resuelve el runtime desde el nucleo comun del fixture.
(cd "$FAKE_MEFISTO" && git init -q && git -c user.email="test@example.com" -c user.name="Test" commit --allow-empty -q -m "commit inicial")

cat > "$FAKE_BIN/gh" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod +x "$FAKE_BIN/gh"

LAST_STDOUT=""
LAST_STDERR=""
LAST_RC=0

# --- mefisto-herdr-pipeline.sh: la otra mitad de CA-3 -----------------------

export HERDR_STUB_LOG="$TMP_DIR/herdr-invocations.log"
export HERDR_STUB_OWNER_PID=$$
export HERDR_STUB_COUNTER="$TMP_DIR/herdr-pane-counter"
HERDR_SCRIPT="$FAKE_MEFISTO/.claude/scripts/mefisto-herdr-pipeline.sh"

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
        # Issue #2284: el pane que despacha (w1:p0) reporta como shell_pid el
        # PID del test, ancestro del lanzador, para pasar el guard de pane propio.
        if [ "${4:-}" = "w1:p0" ] && [ -n "${HERDR_STUB_OWNER_PID:-}" ]; then
            echo "{\"result\":{\"process_info\":{\"shell_pid\":$HERDR_STUB_OWNER_PID,\"foreground_process_group_id\":$HERDR_STUB_OWNER_PID}}}"
        else
            echo '{"result":{"process_info":{"shell_pid":100,"foreground_process_group_id":100}}}'
        fi
        ;;
    "pane run")
        # Confirmacion de arranque (issue #1563, porte #1571): toca el
        # --started-marker de la cmdline de inmediato -- este stub no ejercita
        # el mecanismo de reintento, solo evita que dispatch_to_pane espere el
        # timeout completo por cada bloque.
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

# Stub de "claude" (issue #928): mefisto_resolve_runtime autodetecta cuando
# MEFISTO_RUNTIME no esta fijado (bloques 19-21, ninguno lo fija), y necesita
# resolver a un UNICO runtime instalado. Junto con el PATH recortado de
# run_herdr (mas abajo), evita depender de que haya o no un claude real
# instalado en la maquina que corre la suite.
cat > "$FAKE_BIN/claude" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$FAKE_BIN/claude"

run_herdr() {
    : > "$HERDR_STUB_LOG"
    echo 0 > "$HERDR_STUB_COUNTER"
    local out="$TMP_DIR/stdout" err="$TMP_DIR/stderr"
    (
        cd "$FAKE_MEFISTO" || exit 99
        # Las -u de estado/repo (issue #872) aislan el fixture de un
        # MEFISTO_STATE_DIR/MEFISTO_REPO_ROOT ya exportado en el entorno --
        # p. ej. si este test corre DENTRO de una corrida real de
        # mefisto-tooling-pipeline.sh, que exporta ambos apuntando al repo
        # real. Sin esto, mefisto-state.sh (`: "${VAR:=default}"`) los
        # respeta tal cual y el fixture deja de escribir en su propio
        # FAKE_MEFISTO/.mefisto/pipeline/.
        #
        # PATH="$FAKE_BIN:/usr/bin:/bin" (issue #928), no "$FAKE_BIN:$PATH":
        # acquire_report_pane ahora resuelve el runtime con
        # mefisto_resolve_runtime, y un "claude" real en
        # ~/.local/bin o /opt/homebrew/bin haria la autodeteccion no
        # determinista segun la maquina.
        # -u MEFISTO_RUNTIME (issue #928): ningun bloque herdr de esta suite
        # depende de heredarla, y desfijarla deja la resolucion de runtime en
        # manos del unico stub del PATH recortado -- identica corra la suite
        # sola o dentro de una corrida real del pipeline, que la exporta.
        env -u MEFISTO_UI -u MEFISTO_RUNTIME \
            -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR \
            -u MEFISTO_REPO_ROOT -u MEFISTO_PROJECT_NAME -u MEFISTO_REPO_SLUG \
            PATH="$FAKE_BIN:/usr/bin:/bin" \
            HERDR_ENV=1 HERDR_PANE_ID="w1:p0" HERDR_WORKSPACE_ID="w1" \
            HERDR_STUB_LOG="$HERDR_STUB_LOG" HERDR_STUB_COUNTER="$HERDR_STUB_COUNTER" \
            "$HERDR_SCRIPT" "$@"
    ) </dev/null >"$out" 2>"$err"
    LAST_RC=$?
    LAST_STDOUT=$(cat "$out")
    LAST_STDERR=$(cat "$err")
}

echo ""
echo "[20] mefisto-herdr-pipeline.sh: --tooling reenvia --models al pane run intacto (sin comillas literales)"
run_herdr --tooling 709 --models "writer=sonnet,reviewer=opus"
HERDR_CALLS=$(cat "$HERDR_STUB_LOG")
if [ "$LAST_RC" -eq 0 ]; then pass "--tooling + --models corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
# El pane run quotea cada argv con printf %q, que escapa la coma como '\,' --
# el shell del pane la deshace al ejecutar. Se compara sin los backslashes: lo
# que importa es que --models este con el valor intacto, no la forma del escape.
HERDR_CALLS_UNQ=$(printf '%s' "$HERDR_CALLS" | tr -d '\\')
if printf '%s' "$HERDR_CALLS_UNQ" | grep -qF -- "--models writer=sonnet,reviewer=opus"; then
    pass "el pane run lleva --models con el valor intacto y SIN comillas literales"
else
    fail "el pane run no lleva --models (se perdio en el dispatch) -- log: $HERDR_CALLS"
fi
if printf '%s' "$HERDR_CALLS" | grep -qF -- "--models 'writer=sonnet,reviewer=opus'"; then
    fail "el valor viaja con comillas simples literales (herdr no re-parsea con un shell, printf %q ya lo quotea)"
else
    pass "sin comillas simples literales en el argv del pane"
fi

echo ""
echo "[21] mefisto-herdr-pipeline.sh: --tooling combina --from-stage y --models"
run_herdr --tooling 709 --from-stage 2 --models "reviewer=opus"
HERDR_CALLS=$(cat "$HERDR_STUB_LOG")
if [ "$LAST_RC" -eq 0 ]; then pass "combinado corre sin abortar"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if printf '%s' "$HERDR_CALLS" | grep -qF -- "--from-stage 2" && printf '%s' "$HERDR_CALLS" | grep -qF -- "--models reviewer=opus"; then
    pass "el pane run lleva los dos flags"
else
    fail "falta alguno de los dos flags -- log: $HERDR_CALLS"
fi

echo ""
echo "[22] mefisto-herdr-pipeline.sh: un id de modelo con caracteres de glob llega intacto"
run_herdr --tooling 709 --models 'writer=claude-opus-5[1m]'
HERDR_CALLS=$(cat "$HERDR_STUB_LOG")
HERDR_CALLS_UNQ=$(printf '%s' "$HERDR_CALLS" | tr -d '\\')
if printf '%s' "$HERDR_CALLS_UNQ" | grep -qF -- "--models writer=claude-opus-5[1m]"; then
    pass "'claude-opus-5[1m]' sobrevive (no lo toca la pathname expansion)"
else
    fail "el id de modelo se altero -- log: $HERDR_CALLS"
fi

echo ""
echo "[23] mefisto-herdr-pipeline.sh: --models sin valor aborta con mensaje claro"
run_herdr --tooling 709 --models
if [ "$LAST_RC" -eq 1 ]; then pass "--models sin valor aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "Falta el valor de --models"; then pass "mensaje: falta el valor"; else fail "mensaje inesperado: $LAST_STDERR"; fi

echo ""
echo "[24] mefisto-herdr-pipeline.sh: --batch + --models aborta (ambiguo sobre varios issues, nunca en silencio)"
run_herdr --batch 709 710 --models "writer=sonnet"
if [ "$LAST_RC" -eq 1 ]; then pass "--batch + --models aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$(cat "$HERDR_STUB_LOG")" | grep -q "pane run"; then fail "no deberia despachar ningun pane"; else pass "ningun pane despachado"; fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
