#!/usr/bin/env bash
# test-mefisto-stage-models.sh -- Tests del mecanismo de asignacion de modelo
# por stage (--models, issue #709) en .claude/scripts/_mefisto-common.sh,
# .claude/scripts/mefisto-tooling-pipeline.sh, .claude/scripts/mefisto-tmux-pipeline.sh
# y .claude/scripts/mefisto-herdr-pipeline.sh.
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
#   mefisto-tooling-pipeline.sh (bloques 11-15) -- --models se resuelve ANTES
#       de crear el worktree (CA-1: un malformado no debe dejar un worktree a
#       medias), el mensaje de abort, el wiring del modelo por stage
#       (resolve_stage_model por clave exacta sigue ganando, y sin match cae a
#       mefisto_resolve_model por perfil -- balanced para writer/merge, deep
#       para reviewer -- ya sin los defaults fijos sonnet/opus; tambien ANTES
#       del worktree, y run_agent solo selecciona lo ya resuelto, issue #910) y
#       la ayuda del script.
#   mefisto-tmux-pipeline.sh (bloques 16-19) -- --tooling reenvia --models
#       intacto al send-keys (con comillas simples, CA-3), se combina con
#       --from-stage, --models sin valor aborta, y --batch lo rechaza
#       explicito (ambiguo sobre varios issues).
#   mefisto-herdr-pipeline.sh (bloques 20-24) -- la otra mitad de CA-3: dentro
#       de un pane herdr el valor viaja crudo (sin las comillas que solo
#       sirven al send-keys de tmux), sobrevive un id de modelo con caracteres
#       de glob, y el mismo rechazo explicito en --batch.
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

# --- mefisto-tooling-pipeline.sh: wiring de --models (CA-1/CA-2) ------------

PIPE_PATH="$REPO_ROOT/src/internal/scripts/mefisto-tooling-pipeline.sh"

echo ""
echo "[11] --models se resuelve ANTES de crear el worktree (CA-1: un malformado no debe dejar un worktree a medias)"
parse_line=$(grep -n 'parse_stage_models "\$MODELS_SPEC"' "$PIPE_PATH" | head -n1 | cut -d: -f1)
worktree_line=$(grep -n 'worktree add "\$WORKTREE_PATH"' "$PIPE_PATH" | head -n1 | cut -d: -f1)
if [ -n "$parse_line" ] && [ -n "$worktree_line" ] && [ "$parse_line" -lt "$worktree_line" ]; then
    pass "parse_stage_models (linea $parse_line) antecede a git worktree add (linea $worktree_line)"
else
    fail "orden incorrecto: parse_stage_models=$parse_line, git worktree add=$worktree_line"
fi

echo ""
echo "[12] --models mal formado aborta con mensaje claro"
if grep -qF -- '--models mal formado:' "$PIPE_PATH"; then
    pass "el pipeline aborta con el mensaje '--models mal formado: ...'"
else
    fail "no se encontro el mensaje de abort para --models mal formado"
fi
if grep -qF 'MEFISTO_STAGE_MODELS_ERROR' "$PIPE_PATH"; then
    pass "el mensaje de abort interpola MEFISTO_STAGE_MODELS_ERROR"
else
    fail "el pipeline no interpola MEFISTO_STAGE_MODELS_ERROR en el abort"
fi

echo ""
echo "[13] el modelo por stage se resuelve ANTES del worktree: --models gana por clave exacta, sin defaults fijos sonnet/opus (issue #910)"
if grep -qF 'MEFISTO_STAGE_MODEL_RESUELTO="$(resolve_stage_model "$stage_key" "")"' "$PIPE_PATH"; then
    pass "la resolucion consulta primero el override --models (default vacio = sin match)"
else
    fail "no se encontro la consulta de resolve_stage_model con default vacio"
fi
if grep -qF 'mefisto_resolve_model "$MEFISTO_RUNTIME_RESUELTO" "$agent_id" "$profile" "" "$INTERNAL_MODELS_FILE" > "$out_file"' "$PIPE_PATH"; then
    pass "sin override, cae a mefisto_resolve_model (runtime + id neutral + perfil + mapping interno)"
else
    fail "no se encontro la resolucion via mefisto_resolve_model"
fi
if grep -qF 'INTERNAL_MODELS_FILE="${MEFISTO_MODELS_FILE:-${MEFISTO_LAUNCH_ROOT:-$MEFISTO_REPO_ROOT}/.mefisto/models.json}"' "$PIPE_PATH"; then
    pass "el mapping interno se pasa explicitamente al resolutor comun"
else
    fail "no se encontro la ruta explicita al mapping interno de modelos"
fi
# Redirect simple (>), nunca "$(...)": mefisto_resolve_model deja el motivo del
# fallo en MEFISTO_MODELS_ERROR, y una sustitucion de comando lo perderia en su
# subshell -- el abort del pipeline quedaria con "motivo desconocido" SIEMPRE.
if grep -qF 'abort "No se pudo resolver el modelo de $agent_id (perfil $profile): ${MEFISTO_MODELS_ERROR' "$PIPE_PATH"; then
    pass "el abort interpola MEFISTO_MODELS_ERROR (leible porque la llamada NO va en \$(...))"
else
    fail "el abort del modelo no interpola MEFISTO_MODELS_ERROR"
fi
if grep -qF 'resolve_pipeline_stage_model "writer" "mefisto-writer" "balanced"' "$PIPE_PATH" \
    && grep -qF 'resolve_pipeline_stage_model "reviewer" "mefisto-reviewer" "deep"' "$PIPE_PATH"; then
    pass "perfiles intactos: reviewer=deep, writer (y el stage merge)=balanced"
else
    fail "los perfiles por agente cambiaron o no se encontraron"
fi
# CA-2: igual que --models, un mapping local invalido debe abortar antes de
# dejar un worktree a medias en disco.
model_line=$(grep -n 'resolve_pipeline_stage_model "writer"' "$PIPE_PATH" | head -n1 | cut -d: -f1)
if [ -n "$model_line" ] && [ -n "$worktree_line" ] && [ "$model_line" -lt "$worktree_line" ]; then
    pass "la resolucion del modelo (linea $model_line) antecede a git worktree add (linea $worktree_line)"
else
    fail "orden incorrecto: resolucion de modelo=$model_line, git worktree add=$worktree_line"
fi
# run_agent ya no resuelve nada: solo selecciona el modelo ya resuelto por rol.
if grep -qF 'reviewer) MEFISTO_AGENT_ID="mefisto-reviewer"; AGENT_MODEL="$MODEL_REVIEWER";' "$PIPE_PATH" \
    && grep -qF '*)        MEFISTO_AGENT_ID="mefisto-writer";   AGENT_MODEL="$MODEL_WRITER";' "$PIPE_PATH"; then
    pass "run_agent selecciona el modelo ya resuelto (writer/merge -> MODEL_WRITER, reviewer -> MODEL_REVIEWER)"
else
    fail "run_agent no selecciona el modelo ya resuelto por rol"
fi
if grep -qE 'AGENT_MODEL_DEFAULT="(sonnet|opus)"' "$PIPE_PATH"; then
    fail "quedan defaults fijos sonnet/opus en el pipeline (CA-2: deben desaparecer)"
else
    pass "los defaults fijos sonnet/opus ya no estan en el pipeline"
fi

echo ""
echo "[14] la ayuda del pipeline menciona --models"
if grep -q -- "--models" <(bash "$PIPE_PATH" 2>&1 || true); then
    pass "el uso sin argumentos menciona --models"
else
    fail "el mensaje de uso no menciona --models"
fi

echo ""
echo "[15] el pipeline anuncia el modelo resuelto o heredado y, si aplica, el efectivo sin alterar el argv"
eval "$(awk '/^log_agent_model_invocation\(\) \{/{p=1} p{print} p && /^}/{p=0}' "$PIPE_PATH")"
eval "$(awk '/^log_effective_stage_model\(\) \{/{p=1} p{print} p && /^}/{p=0}' "$PIPE_PATH")"
MODEL_LOG="$(mktemp)"
log() { printf '%s\n' "$*" >> "$MODEL_LOG"; }
: > "$MODEL_LOG"
log_agent_model_invocation writer 'vendor/model-v2'
log_agent_model_invocation reviewer ''
if grep -qxF 'Invocando writer (modelo: vendor/model-v2)...' "$MODEL_LOG" \
    && grep -qxF 'Invocando reviewer (modelo: <heredado>)...' "$MODEL_LOG"; then
    pass "la invocacion muestra modelos concretos y <heredado>"
else
    fail "el anuncio no preserva el modelo concreto o el fallback <heredado>"
fi
: > "$MODEL_LOG"
log_effective_stage_model 1 writer '' '{"model":"runtime/model-effective"}'
log_effective_stage_model 2 reviewer 'modelo/declarado' '{"model":"no-debe-aparecer"}'
log_effective_stage_model merge writer '' 'null'
if [ "$(wc -l < "$MODEL_LOG" | tr -d ' ')" = 1 ] \
    && grep -qxF 'MODELS: stage 1/writer -> runtime/model-effective (efectivo)' "$MODEL_LOG"; then
    pass "solo un modelo heredado con metrica no nula anuncia el efectivo"
else
    fail "el anuncio efectivo no respeta herencia/modelo nulo"
fi
rm -f "$MODEL_LOG"
announce_line=$(grep -nF 'log_agent_model_invocation "$agent" "$AGENT_MODEL"' "$PIPE_PATH" | head -n1 | cut -d: -f1)
argv_line=$(grep -nF '"$RUN_AGENT_BIN" "${RUN_AGENT_ARGS[@]}"' "$PIPE_PATH" | head -n1 | cut -d: -f1)
if [ -n "$announce_line" ] && [ -n "$argv_line" ] && [ "$announce_line" -lt "$argv_line" ]; then
    pass "el anuncio ocurre antes del runner"
else
    fail "orden incorrecto: anuncio=$announce_line runner=$argv_line"
fi
if grep -qF '[ -n "$AGENT_MODEL" ] && RUN_AGENT_ARGS+=(--model "$AGENT_MODEL")' "$PIPE_PATH"; then
    pass "el argv condicional del runner permanece intacto"
else
    fail "el anuncio altero el argv condicional del runner"
fi

# --- Effort por agente (issue #2499) ------------------------------------
echo ""
echo "[25] el effort se resuelve ANTES del worktree y run_agent lo pasa por rol solo si no es vacio"
effort_line=$(grep -n '^resolve_pipeline_stage_effort "writer"' "$PIPE_PATH" | head -n1 | cut -d: -f1)
if [ -n "$effort_line" ] && [ "$effort_line" -lt "$worktree_line" ]; then pass "resolucion del effort (linea $effort_line) antes del worktree (linea $worktree_line)"; else fail "orden incorrecto: effort=$effort_line worktree=$worktree_line"; fi
if grep -qF '[ -n "$AGENT_EFFORT" ] && RUN_AGENT_ARGS+=(--effort "$AGENT_EFFORT")' "$PIPE_PATH" \
    && grep -qF 'AGENT_EFFORT="$EFFORT_REVIEWER"' "$PIPE_PATH" && grep -qF 'AGENT_EFFORT="$EFFORT_WRITER"' "$PIPE_PATH"; then
    pass "run_agent selecciona el effort por rol y lo pasa condicionalmente"
else
    fail "run_agent no cablea --effort por rol"
fi

# Ejecuta la funcion real contra el adaptador fake. Args: models.json, dir de agentes.
E_TMP="$(mktemp -d)"
E_RES=""
run_effort_case() {
    local mapping="$1" agents_dir="${2:-$REPO_ROOT/src/internal/agents}"
    local fakescripts="$E_TMP/src/internal/scripts"
    rm -rf "$E_TMP/src"; mkdir -p "$fakescripts"
    ln -s "$agents_dir" "$E_TMP/src/internal/agents"
    : > "$E_TMP/events.log"
    E_RES="$(
        SCRIPT_DIR="$fakescripts"
        EVENTS_LOG_ABS="$E_TMP/events.log"
        MEFISTO_RUNTIME_RESUELTO=fake
        INTERNAL_MODELS_FILE="$mapping"
        abort() { echo "ABORT: $*"; exit 1; }
        source "$REPO_ROOT/src/runtime/lib/mefisto-models.sh"
        source "$REPO_ROOT/src/internal/scripts/lib/frontmatter.sh"
        eval "$(awk '/^resolve_pipeline_stage_effort\(\) \{/{p=1} p{print} p && /^}/{p=0}' "$PIPE_PATH")"
        resolve_pipeline_stage_effort writer mefisto-writer || exit 1
        w="$MEFISTO_STAGE_EFFORT_RESUELTO"
        resolve_pipeline_stage_effort reviewer mefisto-reviewer || exit 1
        echo "W=$w R=$MEFISTO_STAGE_EFFORT_RESUELTO"
    )"
}
cat > "$E_TMP/models.json" <<'JSON'
{"fake":{"efforts":{"levels":{"light":"fake-light","standard":"fake-standard","thorough":"fake-thorough"}}}}
JSON
cat > "$E_TMP/models-light.json" <<'JSON'
{"fake":{"efforts":{"levels":{"light":"fake-light","standard":"fake-standard","thorough":"fake-thorough"},"agents":{"mefisto-writer":"light"}}}}
JSON
echo '{"fake":{"efforts":{"agents":{"mefisto-writer":"extremo"}}}}' > "$E_TMP/models-bad.json"

echo ""
echo "[26] sin mapping de agente: writer recibe el nativo de standard y reviewer el de thorough; events.log registra EFFORTS"
run_effort_case "$E_TMP/models.json"
if [ "$E_RES" = "W=fake-standard R=fake-thorough" ]; then pass "writer=standard, reviewer=thorough"; else fail "esperaba W=fake-standard R=fake-thorough (obtenido '$E_RES')"; fi
if grep -qF 'EFFORTS: writer -> fake-standard (nivel standard)' "$E_TMP/events.log" \
    && grep -qF 'EFFORTS: reviewer -> fake-thorough (nivel thorough)' "$E_TMP/events.log"; then pass "linea EFFORTS por stage"; else fail "events.log sin lineas EFFORTS: $(cat "$E_TMP/events.log")"; fi

echo ""
echo "[27] efforts.agents.mefisto-writer=light: el writer cambia, el reviewer no"
run_effort_case "$E_TMP/models-light.json"
if [ "$E_RES" = "W=fake-light R=fake-thorough" ]; then pass "writer=light, reviewer intacto"; else fail "obtenido '$E_RES'"; fi

echo ""
echo "[28] fuente sin effort y mapping invalido abortan citando agente y MEFISTO_EFFORTS_ERROR (antes del worktree)"
mkdir -p "$E_TMP/agents-noeffort"
for a in mefisto-writer mefisto-reviewer; do
    grep -v '"effort"' "$REPO_ROOT/src/internal/agents/$a.md" > "$E_TMP/agents-noeffort/$a.md"
done
run_effort_case "$E_TMP/models.json" "$E_TMP/agents-noeffort"
if printf '%s' "$E_RES" | grep -q 'ABORT:.*mefisto-writer.*MEFISTO_EFFORTS_ERROR'; then pass "fuente sin effort aborta citando el agente"; else fail "obtenido '$E_RES'"; fi
run_effort_case "$E_TMP/models-bad.json"
if printf '%s' "$E_RES" | grep -q 'ABORT:.*mefisto-writer.*MEFISTO_EFFORTS_ERROR='; then pass "mapping invalido aborta citando agente y MEFISTO_EFFORTS_ERROR"; else fail "obtenido '$E_RES'"; fi
rm -rf "$E_TMP"

# --- mefisto-tmux-pipeline.sh / mefisto-herdr-pipeline.sh: reenvio/rechazo --
#
# Mismo arnes que test-harness-version.sh: fixture con .claude-plugin/plugin.json
# (assert_in_mefisto lo exige) y copias de los scripts reales bajo
# .claude/scripts/, mas un stub de tmux/herdr en PATH que solo registra la
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
cp "$REPO_ROOT/.claude/scripts/mefisto-tmux-pipeline.sh" "$FAKE_MEFISTO/.claude/scripts/mefisto-tmux-pipeline.sh"
cp "$REPO_ROOT/src/internal/scripts/mefisto-tmux-pipeline.sh" "$FAKE_MEFISTO/src/internal/scripts/mefisto-tmux-pipeline.sh"
cp "$REPO_ROOT/.claude/scripts/mefisto-herdr-pipeline.sh" "$FAKE_MEFISTO/.claude/scripts/mefisto-herdr-pipeline.sh"
cp "$REPO_ROOT/src/internal/scripts/mefisto-herdr-pipeline.sh" "$FAKE_MEFISTO/src/internal/scripts/mefisto-herdr-pipeline.sh"
# Los lanzadores resuelven el runtime desde el nucleo comun del fixture.
(cd "$FAKE_MEFISTO" && git init -q && git -c user.email="test@example.com" -c user.name="Test" commit --allow-empty -q -m "commit inicial")

cat > "$FAKE_BIN/gh" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod +x "$FAKE_BIN/gh"

cat > "$FAKE_BIN/tmux" <<'STUB'
#!/usr/bin/env bash
set -u
echo "tmux $*" >> "$TMUX_STUB_LOG"
case "${1:-}" in
    has-session)
        exit 1
        ;;
    list-panes)
        for a in "$@"; do
            if [ "$a" = "#{pane_dead}" ]; then
                echo "0"
                exit 0
            fi
        done
        echo "%0"
        ;;
    split-window)
        echo "%1"
        ;;
    *)
        exit 0
        ;;
esac
STUB
chmod +x "$FAKE_BIN/tmux"

export TMUX_STUB_LOG="$TMP_DIR/tmux.log"
TMUX_SCRIPT="$FAKE_MEFISTO/.claude/scripts/mefisto-tmux-pipeline.sh"
export MEFISTO_UI=tmux

LAST_STDOUT=""
LAST_STDERR=""
LAST_RC=0

run_wrapper() {
    : > "$TMUX_STUB_LOG"
    local out="$TMP_DIR/stdout" err="$TMP_DIR/stderr"
    (
        cd "$FAKE_MEFISTO" || exit 99
        PATH="$FAKE_BIN:$PATH" "$TMUX_SCRIPT" "$@"
    ) </dev/null >"$out" 2>"$err"
    LAST_RC=$?
    LAST_STDOUT=$(cat "$out")
    LAST_STDERR=$(cat "$err")
}

echo ""
echo "[16] mefisto-tmux-pipeline.sh: --tooling reenvia --models intacto al send-keys (con comillas simples)"
run_wrapper --tooling 709 --models "writer=sonnet,reviewer=opus"
if [ "$LAST_RC" -eq 0 ]; then pass "--tooling + --models corre sin abortar (rc=$LAST_RC)"; else fail "--tooling + --models no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if grep -qF "mefisto-tooling-pipeline.sh 709 --models 'writer=sonnet,reviewer=opus'" "$TMUX_STUB_LOG"; then
    pass "send-keys incluye el issue y --models con comillas simples intacto"
else
    fail "send-keys no compuso '709 --models ...' -- log: $(cat "$TMUX_STUB_LOG")"
fi

echo ""
echo "[17] mefisto-tmux-pipeline.sh: --tooling combina --from-stage y --models en orden"
run_wrapper --tooling 709 --from-stage 2 --models "reviewer=opus"
if [ "$LAST_RC" -eq 0 ]; then pass "combinado corre sin abortar"; else fail "no deberia abortar (rc=$LAST_RC, stderr: $LAST_STDERR)"; fi
if grep -qF "mefisto-tooling-pipeline.sh 709 --from-stage 2 --models 'reviewer=opus'" "$TMUX_STUB_LOG"; then
    pass "send-keys combina --from-stage y --models en orden"
else
    fail "orden incorrecto -- log: $(cat "$TMUX_STUB_LOG")"
fi

echo ""
echo "[18] mefisto-tmux-pipeline.sh: --models sin valor aborta con mensaje claro"
run_wrapper --tooling 709 --models
if [ "$LAST_RC" -eq 1 ]; then pass "--models sin valor aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "Falta el valor de --models"; then pass "mensaje: falta el valor"; else fail "mensaje inesperado: $LAST_STDERR"; fi

echo ""
echo "[19] mefisto-tmux-pipeline.sh: --batch + --models aborta (ambiguo sobre varios issues, nunca en silencio)"
run_wrapper --batch 709 710 --models "writer=sonnet"
if [ "$LAST_RC" -eq 1 ]; then pass "--batch + --models aborta"; else fail "deberia abortar (rc=$LAST_RC)"; fi
if printf '%s' "$LAST_STDERR" | grep -q "no es valido con --batch"; then pass "mensaje: no valido con --batch"; else fail "mensaje inesperado: $LAST_STDERR"; fi

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
# run_herdr (mas abajo), evita depender de que claude/opencode -- reales --
# esten ambos o ninguno instalados en la maquina que corre la suite.
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
        # mefisto_resolve_runtime, y un "claude"/"opencode" real en
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
