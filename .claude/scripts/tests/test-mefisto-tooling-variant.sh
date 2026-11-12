#!/usr/bin/env bash
# test-mefisto-tooling-variant.sh -- Tests del modo --variant (corridas
# paralelas del mismo issue, issue #711) en .claude/scripts/_mefisto-common.sh,
# .claude/scripts/mefisto-launch-pipeline.sh y .claude/scripts/mefisto-herdr-pipeline.sh.
# El modo variante del pipeline interno de tooling lo prueba
# mefisto-tooling-pipeline.test.mts.
#
# Contraparte interna de scripts/tests/test-tooling-variant.sh (issue #710,
# lado publicado): mismo contrato de UX, verificado sobre las copias internas
# -- MEF-ADR-0019 prohibe compartir codigo entre los dos lados, asi que este
# archivo no importa nada del publicado.
#
# Cubre:
#   validate_variant_label (bloques 1-6) -- vacio, longitud (40 OK, 41
#       rechazado), caracteres validos ([a-z0-9-]) e invalidos (mayusculas,
#       espacios, guion bajo, unicode), todos con el motivo en
#       MEFISTO_VARIANT_LABEL_ERROR (CA-1).
#   mefisto-launch-pipeline.sh (bloques 7-10) -- --tooling reenvia --variant
#       intacto al sub-pipeline desacoplado, combinado con --from-stage/--models
#       en orden, --variant sin valor aborta, y --batch lo rechaza (ambiguo
#       sobre varios issues).
#   mefisto-herdr-pipeline.sh (bloques 11-14) -- misma superficie: --tooling
#       reenvia --variant al pane run (solo y combinado con --models), sin
#       valor aborta, y --batch lo rechaza.
#
# Uso: .claude/scripts/tests/test-mefisto-tooling-variant.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# validate_variant_label vive en _mefisto-common.sh; sourcearlo solo la
# define (es una libreria, no ejecuta nada).
# shellcheck source=/dev/null
source "$REPO_ROOT/.claude/scripts/_mefisto-common.sh" 2>/dev/null

echo "[1] validate_variant_label: label vacio se rechaza (CA-1)"
if validate_variant_label ""; then fail "label vacio no deberia retornar 0"; else pass "label vacio aborta"; fi
if printf '%s' "$MEFISTO_VARIANT_LABEL_ERROR" | grep -qi "vacio"; then pass "el error menciona 'vacio'"; else fail "MEFISTO_VARIANT_LABEL_ERROR inesperado: '$MEFISTO_VARIANT_LABEL_ERROR'"; fi

echo ""
echo "[2] validate_variant_label: label valido de una letra"
if validate_variant_label "a"; then pass "label de 1 char retorna 0"; else fail "'a' no deberia rechazarse"; fi

echo ""
echo "[3] validate_variant_label: slug tipico valido"
if validate_variant_label "experimento-a"; then pass "'experimento-a' retorna 0"; else fail "'experimento-a' no deberia rechazarse"; fi

echo ""
echo "[4] validate_variant_label: limite de longitud (40 OK, 41 rechazado)"
LABEL_40=$(printf 'a%.0s' $(seq 1 40))
LABEL_41=$(printf 'a%.0s' $(seq 1 41))
if [ "${#LABEL_40}" -eq 40 ] && [ "${#LABEL_41}" -eq 41 ]; then pass "fixtures de longitud correctas"; else fail "fixtures mal construidas"; fi
if validate_variant_label "$LABEL_40"; then pass "label de 40 chars retorna 0"; else fail "40 chars no deberia rechazarse"; fi
if validate_variant_label "$LABEL_41"; then fail "label de 41 chars no deberia retornar 0"; else pass "41 chars aborta"; fi
if printf '%s' "$MEFISTO_VARIANT_LABEL_ERROR" | grep -q "40 caracteres"; then pass "el error menciona el limite de 40 caracteres"; else fail "MEFISTO_VARIANT_LABEL_ERROR inesperado: '$MEFISTO_VARIANT_LABEL_ERROR'"; fi

echo ""
echo "[5] validate_variant_label: caracteres invalidos se rechazan (CA-1)"
for bad in "Experimento" "experimento_a" "experimento a" "experimento.a" "a/b"; do
    if validate_variant_label "$bad"; then
        fail "'$bad' no deberia retornar 0"
    else
        pass "'$bad' aborta"
    fi
    if printf '%s' "$MEFISTO_VARIANT_LABEL_ERROR" | grep -qF "$bad"; then
        pass "el error nombra el label invalido '$bad'"
    else
        fail "MEFISTO_VARIANT_LABEL_ERROR no menciona '$bad': '$MEFISTO_VARIANT_LABEL_ERROR'"
    fi
done

echo ""
echo "[6] validate_variant_label: digitos y guiones solos son validos"
if validate_variant_label "123-456"; then pass "'123-456' retorna 0"; else fail "'123-456' no deberia rechazarse"; fi

echo ""
echo "----------------------------------------"
echo "  _mefisto-common.sh: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

# --- mefisto-launch-pipeline.sh / mefisto-herdr-pipeline.sh: reenvio/rechazo --
#
# Mismo arnes que test-mefisto-stage-models.sh: fixture con
# .claude-plugin/plugin.json (assert_in_mefisto lo exige) y copias de los
# scripts reales bajo .claude/scripts/, mas un stub de herdr en PATH que
# solo registra la invocacion sin tocar un servidor real.

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
cp "$REPO_ROOT/.claude/scripts/_mefisto-common.sh" "$FAKE_MEFISTO/.claude/scripts/_mefisto-common.sh"
cp "$REPO_ROOT/src/internal/scripts/lib/mefisto-state.sh" "$FAKE_MEFISTO/src/internal/scripts/lib/mefisto-state.sh"
# Effort por agente (issue #2499): el pipeline lee el nivel de fabrica del
# campo `effort` de la fuente neutral de writer/reviewer con frontmatter.sh,
# antes de crear el worktree; sin estas copias aborta en el arranque.
cp "$REPO_ROOT/src/internal/scripts/lib/frontmatter.sh" "$FAKE_MEFISTO/src/internal/scripts/lib/frontmatter.sh"
mkdir -p "$FAKE_MEFISTO/src/internal/agents"
cp "$REPO_ROOT/src/internal/agents/mefisto-writer.md" "$REPO_ROOT/src/internal/agents/mefisto-reviewer.md" "$FAKE_MEFISTO/src/internal/agents/"
# El bloque [18] invoca el pipeline real: copia el nucleo comun completo, no
# los shims temporales que este corte elimina de src/internal/.
cp -R "$REPO_ROOT/src/runtime" "$FAKE_MEFISTO/src/runtime"
mkdir -p "$FAKE_MEFISTO/src/internal/prompts"
cp "$REPO_ROOT/src/internal/prompts/noninteractive-system.md" "$FAKE_MEFISTO/src/internal/prompts/noninteractive-system.md"
chmod +x "$FAKE_MEFISTO/src/runtime/mefisto-run-agent.sh"
cp "$REPO_ROOT/.claude/scripts/mefisto-launch-pipeline.sh" "$FAKE_MEFISTO/.claude/scripts/mefisto-launch-pipeline.sh"
cp "$REPO_ROOT/src/internal/scripts/mefisto-launch-pipeline.sh" "$FAKE_MEFISTO/src/internal/scripts/mefisto-launch-pipeline.sh"
cp "$REPO_ROOT/.claude/scripts/mefisto-herdr-pipeline.sh" "$FAKE_MEFISTO/.claude/scripts/mefisto-herdr-pipeline.sh"
cp "$REPO_ROOT/src/internal/scripts/mefisto-herdr-pipeline.sh" "$FAKE_MEFISTO/src/internal/scripts/mefisto-herdr-pipeline.sh"
# Sub-pipelines stub: el modo desacoplado los ejecuta de verdad, asi que
# registran su argv (una palabra por corchete) y el runtime que heredan.
export SUBPIPE_STUB_LOG="$TMP_DIR/sub-pipeline.log"
install_subpipeline_stubs() {
    local sub
    for sub in mefisto-tooling-pipeline.sh mefisto-batch-pipeline.sh; do
        cat > "$FAKE_MEFISTO/src/internal/scripts/$sub" <<'STUB'
#!/usr/bin/env bash
{
    echo "script: $(basename "$0")"
    printf 'argv:'; printf ' [%s]' "$@"; printf '\n'
    echo "runtime: ${MEFISTO_RUNTIME:-}"
} > "$SUBPIPE_STUB_LOG"
STUB
        chmod +x "$FAKE_MEFISTO/src/internal/scripts/$sub"
    done
}
install_subpipeline_stubs
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

LAUNCH_SCRIPT="$FAKE_MEFISTO/.claude/scripts/mefisto-launch-pipeline.sh"
export MEFISTO_UI=mod

wait_for_subpipeline() {
    for _ in $(seq 1 50); do
        [ -s "$SUBPIPE_STUB_LOG" ] && return 0
        sleep 0.1
    done
    return 1
}

LAST_STDOUT=""
LAST_STDERR=""
LAST_RC=0

run_wrapper() {
    rm -f "$SUBPIPE_STUB_LOG"
    local out="$TMP_DIR/stdout" err="$TMP_DIR/stderr"
    (
        cd "$FAKE_MEFISTO" || exit 99
        PATH="$FAKE_BIN:$PATH" "$LAUNCH_SCRIPT" "$@"
    ) </dev/null >"$out" 2>"$err"
    LAST_RC=$?
    LAST_STDOUT=$(cat "$out")
    LAST_STDERR=$(cat "$err")
}

echo ""
echo "[7] mefisto-launch-pipeline.sh: --tooling reenvia --variant intacto al sub-pipeline"
run_wrapper --tooling 711 --variant experimento-a
if [ "$LAST_RC" -eq 0 ]; then pass "--tooling + --variant corre sin abortar (rc=$LAST_RC)"; else fail "--tooling + --variant no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if wait_for_subpipeline && grep -qxF "script: mefisto-tooling-pipeline.sh" "$SUBPIPE_STUB_LOG" && grep -qxF "argv: [711] [--variant] [experimento-a]" "$SUBPIPE_STUB_LOG"; then
    pass "el sub-pipeline recibe el issue y --variant intacto"
else
    fail "el sub-pipeline no recibio '711 --variant ...' -- log: $(cat "$SUBPIPE_STUB_LOG" 2>/dev/null)"
fi

echo ""
echo "[8] mefisto-launch-pipeline.sh: --tooling combina --from-stage, --models y --variant en orden"
run_wrapper --tooling 711 --from-stage 2 --models "reviewer=opus" --variant b
if [ "$LAST_RC" -eq 0 ]; then pass "combinado corre sin abortar"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if wait_for_subpipeline && grep -qxF "argv: [711] [--from-stage] [2] [--models] [reviewer=opus] [--variant] [b]" "$SUBPIPE_STUB_LOG"; then
    pass "el sub-pipeline recibe los tres flags en orden"
else
    fail "orden incorrecto -- log: $(cat "$SUBPIPE_STUB_LOG" 2>/dev/null)"
fi

echo ""
echo "[9] mefisto-launch-pipeline.sh: --variant sin valor aborta con mensaje claro"
run_wrapper --tooling 711 --variant
if [ "$LAST_RC" -eq 1 ]; then pass "--variant sin valor aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "Falta el valor de --variant"; then pass "mensaje: falta el valor"; else fail "mensaje inesperado: $LAST_STDERR"; fi

echo ""
echo "[10] mefisto-launch-pipeline.sh: --batch + --variant aborta (ambiguo sobre varios issues, nunca en silencio)"
run_wrapper --batch 711 712 --variant a
if [ "$LAST_RC" -eq 1 ]; then pass "--batch + --variant aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "no es valido con --batch"; then pass "mensaje: no valido con --batch"; else fail "mensaje inesperado: $LAST_STDERR"; fi

echo ""
echo "[11] mefisto-launch-pipeline.sh: --batch sucio aborta antes de lanzar"
git -C "$FAKE_MEFISTO" checkout -q -b feature-sucia
echo "nota pendiente" > "$FAKE_MEFISTO/nota-pendiente.txt"
run_wrapper --batch 711 712
rm -f "$FAKE_MEFISTO/nota-pendiente.txt"
git -C "$FAKE_MEFISTO" checkout -q master 2>/dev/null || git -C "$FAKE_MEFISTO" checkout -q main
if [ "$LAST_RC" -eq 1 ]; then pass "--batch sucio aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -qi "arbol.*limpio"; then pass "el error explica que solo se recupera con arbol limpio"; else fail "mensaje inesperado: $LAST_STDERR"; fi
sleep 0.5
if [ -e "$SUBPIPE_STUB_LOG" ]; then fail "no deberia lanzar el batch -- log: $(cat "$SUBPIPE_STUB_LOG")"; else pass "no lanza el batch antes del preflight"; fi

echo ""
echo "[12] mefisto-launch-pipeline.sh: --batch limpio recupera y actualiza main antes del dispatch"
git -C "$PUBLISHER" commit -q --allow-empty -m "origin avanza antes del preflight"
git -C "$PUBLISHER" push -q origin main
EXPECTED_MAIN=$(git -C "$PUBLISHER" rev-parse main)
git -C "$FAKE_MEFISTO" checkout -q -b feature-limpia
run_wrapper --batch 711 712
CURRENT_BRANCH=$(git -C "$FAKE_MEFISTO" rev-parse --abbrev-ref HEAD)
CURRENT_MAIN=$(git -C "$FAKE_MEFISTO" rev-parse main)
if [ "$LAST_RC" -eq 0 ]; then pass "--batch limpio se despacha"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if [ "$CURRENT_BRANCH" = main ] && [ "$CURRENT_MAIN" = "$EXPECTED_MAIN" ]; then pass "recupera a main actualizado"; else fail "rama/base inesperada: HEAD=$CURRENT_BRANCH main=$CURRENT_MAIN esperado=$EXPECTED_MAIN"; fi
if wait_for_subpipeline && grep -qxF "script: mefisto-batch-pipeline.sh" "$SUBPIPE_STUB_LOG" && grep -qxF "argv: [711] [712]" "$SUBPIPE_STUB_LOG"; then pass "despacha solo despues de recuperar la base"; else fail "no despacho el batch -- log: $(cat "$SUBPIPE_STUB_LOG" 2>/dev/null)"; fi

echo ""
echo "----------------------------------------"
echo "  mefisto-launch-pipeline.sh: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

# --- mefisto-herdr-pipeline.sh: misma superficie, dentro de un pane herdr ---

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

# Stub de "claude" (issue #928): desde que acquire_report_pane resuelve el
# runtime con mefisto_resolve_runtime, los bloques 11-14 dependen de que la
# autodeteccion vea UN solo runtime instalado. Con el PATH recortado de
# run_herdr (abajo) este stub es el unico candidato, asi que la resolucion es
# la misma en cualquier maquina, tenga o no un claude real instalado.
# Ningun bloque llega a ejecutarlo: el pane run del stub de herdr solo registra
# la linea tecleada.
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
        # PATH="$FAKE_BIN:/usr/bin:/bin" y -u MEFISTO_RUNTIME (issue #928): la
        # resolucion de runtime de acquire_report_pane no debe depender ni de
        # que CLIs reales tenga la maquina (tipicamente en ~/.local/bin o
        # /opt/homebrew/bin, fuera de este PATH recortado) ni de un
        # MEFISTO_RUNTIME ya exportado por la corrida que ejecuta esta suite.
        # /usr/bin y /bin alcanzan para git, jq y el resto de coreutils.
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
echo "[11] herdr: --tooling reenvia --models y --variant combinados al pane run"
run_herdr --tooling 711 --models "writer=sonnet" --variant experimento-a
HERDR_CALLS=$(cat "$HERDR_STUB_LOG")
if [ "$LAST_RC" -eq 0 ]; then pass "--tooling + --models + --variant corre sin abortar (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
HERDR_CALLS_UNQ=$(printf '%s' "$HERDR_CALLS" | tr -d '\\')
if printf '%s' "$HERDR_CALLS_UNQ" | grep -qF -- "--models writer=sonnet --variant experimento-a"; then
    pass "el pane run lleva --models y --variant, en ese orden, con el valor intacto"
else
    fail "el pane run no lleva la combinacion esperada -- log: $HERDR_CALLS"
fi

echo ""
echo "[12] herdr: --tooling reenvia --variant solo (sin --models)"
run_herdr --tooling 711 --variant b
HERDR_CALLS=$(cat "$HERDR_STUB_LOG")
HERDR_CALLS_UNQ=$(printf '%s' "$HERDR_CALLS" | tr -d '\\')
if [ "$LAST_RC" -eq 0 ]; then pass "--tooling + --variant corre sin abortar"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if printf '%s' "$HERDR_CALLS_UNQ" | grep -qF -- "--variant b"; then
    pass "el pane run lleva --variant"
else
    fail "el pane run no lleva --variant -- log: $HERDR_CALLS"
fi

echo ""
echo "[13] herdr: --variant sin valor aborta con mensaje claro"
run_herdr --tooling 711 --variant
if [ "$LAST_RC" -eq 1 ]; then pass "--variant sin valor aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "Falta el valor de --variant"; then pass "mensaje: falta el valor"; else fail "mensaje inesperado: $LAST_STDERR"; fi

echo ""
echo "[14] herdr: --batch + --variant aborta (ambiguo sobre varios issues, nunca en silencio)"
run_herdr --batch 711 712 --variant a
if [ "$LAST_RC" -eq 1 ]; then pass "--batch + --variant aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "no es valido con --batch"; then pass "mensaje: no valido con --batch"; else fail "mensaje inesperado: $LAST_STDERR"; fi
if printf '%s' "$(cat "$HERDR_STUB_LOG")" | grep -q "pane run"; then fail "no deberia despachar ningun pane"; else pass "ningun pane despachado"; fi

echo ""
echo "----------------------------------------"
echo "  mefisto-herdr-pipeline.sh: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

echo ""
echo "[19] mefisto-launch-pipeline.sh: --tooling propaga MEFISTO_RUNTIME al sub-pipeline cuando el launcher lo hereda (issue #871, CA-2)"
# Sin la variable en el sub-pipeline, este autodetectaria el runtime y una
# corrida lanzada con otro runtime caeria en Claude Code sin avisar.
install_subpipeline_stubs
MEFISTO_RUNTIME=fake run_wrapper --tooling 711
if [ "$LAST_RC" -eq 0 ]; then pass "corre sin abortar con MEFISTO_RUNTIME heredado (rc=$LAST_RC)"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if wait_for_subpipeline && grep -qxF "argv: [711]" "$SUBPIPE_STUB_LOG" && grep -qxF "runtime: fake" "$SUBPIPE_STUB_LOG"; then
    pass "el sub-pipeline corre con MEFISTO_RUNTIME=fake"
else
    fail "el sub-pipeline no recibe MEFISTO_RUNTIME=fake -- log: $(cat "$SUBPIPE_STUB_LOG" 2>/dev/null)"
fi

# Contraparte negativa: sin la variable en el entorno del wrapper no se fija
# ninguna. Un default aqui romperia la precedencia -- quien resuelve el
# runtime ausente es el sub-pipeline, no el lanzador.
(unset MEFISTO_RUNTIME MEFISTO_MODELS_FILE; run_wrapper --tooling 711)
if wait_for_subpipeline && grep -qxF "runtime: " "$SUBPIPE_STUB_LOG"; then
    pass "sin MEFISTO_RUNTIME heredado el sub-pipeline corre sin runtime fijado"
else
    fail "sin MEFISTO_RUNTIME heredado el launcher igual lo fija -- log: $(cat "$SUBPIPE_STUB_LOG" 2>/dev/null)"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
