#!/usr/bin/env bash
# Regresion focalizada de #1062: el pipeline publicado delega la ejecucion al
# runner y conserva ids/perfiles neutrales, sin fijar un CLI de proveedor.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PIPELINE="$ROOT/scripts/tooling-pipeline.sh"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
contains() { grep -Fq -- "$1" "$PIPELINE" && pass "$2" || fail "$2"; }
absent() { grep -Fq -- "$1" "$PIPELINE" && fail "$2" || pass "$2"; }

echo '[frontera] runner neutral'
agent_file_has_id() {
    local path="$1" id="$2"
    [ -f "$path" ] && sed -n 's/^name: "\([^"]*\)"$/\1/p' "$path" | sed -n '1p' | grep -qxF "$id"
}

for agent_spec in \
    "agents/tooling-writer.md tooling-writer" \
    "agents/tooling-reviewer.md tooling-reviewer" \
    ".claude/agents/mefisto-writer.md mefisto-writer" \
    ".claude/agents/mefisto-reviewer.md mefisto-reviewer"; do
    agent_path=${agent_spec% *}
    agent_id=${agent_spec##* }
    if agent_file_has_id "$ROOT/$agent_path" "$agent_id"; then
        pass "agente resoluble: $agent_path declara name: $agent_id"
    else
        fail "agente no resoluble: $agent_path debe existir y declarar name: $agent_id"
    fi
done

contains 'mefisto-run-agent.sh' 'localiza el runner desde la clausura publicada'
contains 'tooling-writer balanced' 'writer usa id y perfil neutral'
contains 'tooling-reviewer deep' 'reviewer usa id y perfil neutral'
contains '--resume-session' 'reanudacion via session_id neutral'
contains 'agent_events_denials' 'retry por permisos consume denials neutral'
contains 'runtime_supports_resume' 'consulta capability de reanudacion'
absent 'claude -p' 'no invoca Claude directamente'
absent 'CLAUDE_CONFIG_DIR' 'no inspecciona stores privados'
absent 'bypassPermissions' 'no fija permisos de un runtime'
absent 'output-format' 'no fija formatos de stream de un runtime'
absent 'kill -9' 'no conserva watchdog propio'
contains 'if "$RUN_AGENT_BIN" "${args[@]}"' 'invoca el runner con un array, sin eval'
contains 'log_agent_model_invocation "$agent" "$model"' 'anuncia el modelo resuelto antes de invocar writer, reviewer o merge'
contains '[ -n "$model" ] && args+=(--model "$model")' 'conserva intacto el argv condicional del runner'
contains '[ -n "$effort" ] && args+=(--effort "$effort")' 'pasa --effort solo si el effort resuelto no es vacio'
contains 'resolve_pipeline_agent_effort writer tooling-writer' 'resuelve el effort del writer antes del worktree'
contains 'resolve_pipeline_agent_effort reviewer tooling-reviewer' 'resuelve el effort del reviewer antes del worktree'
contains 'MEFISTO_EFFORTS_ERROR' 'un mapping de effort invalido aborta citando MEFISTO_EFFORTS_ERROR'
contains 'case "$agent" in reviewer) agent_id="tooling-reviewer"; profile="deep"; model="$MODEL_REVIEWER"; effort="$EFFORT_REVIEWER" ;; *) agent_id="tooling-writer"; profile="balanced"; model="$MODEL_WRITER"; effort="$EFFORT_WRITER" ;; esac' 'el anuncio usa el modelo y el effort ya resueltos por rol'
contains 'agent_events_completed_successfully' 'exige terminal neutral de exito'
contains 'mefisto_state_path "summaries/stage-${stage}-${agent}.md" "$WORKTREE_PATH"' 'escribe summaries en el estado canonico del worktree'
contains '--redact-observability' 'pide persistencia redactada al runner'
absent '--raw-log' 'no persiste raw del runtime'
absent '--stderr-log' 'no persiste stderr del runtime'
contains "PIPELINE_OWN_WRITES=(':!.mefisto/pipeline')" 'excluye solo el estado canonico del commit del agente'
contains 'attempt-${attempt}.events.jsonl' 'cada intento conserva su propio JSONL neutral'
contains 'enrich_tooling_stage_metrics' 'status, metricas e history reciben correlacion neutral completa'
contains 'PIPELINE_TMP_DIR="$(mktemp -d -t mefisto-tooling)"' 'inputs y salida del runner viven en un directorio temporal'
absent "trap 'rm -f \"\${prompt_file:-}\"" 'no depende de RETURN para limpiar inputs en abortos'
absent '.claude/settings.json 2>/dev/null' 'no parchea ni restaura settings de Claude'
contains 'get_harness_identity_json "$MEFISTO_RUNTIME_RESUELTO"' 'valida metadata distribuida contra el runtime activo'
contains 'HISTORY_FILE="$(mefisto_state_path' 'history obtiene su destino con el helper canonico'
absent 'pipeline-history.jsonl" 2>/dev/null' 'history no concatena a mano su ruta de escritura'

eval "$(awk '/^log_agent_model_invocation\(\) \{/{p=1} p{print} p && /^}/{p=0}' "$PIPELINE")"
MODEL_LOG="$(mktemp)"
log() { printf '%s\n' "$*" >> "$MODEL_LOG"; }
: > "$MODEL_LOG"
log_agent_model_invocation writer 'vendor/model-v2'
log_agent_model_invocation reviewer ''
if grep -qxF 'Invocando writer (modelo: vendor/model-v2)...' "$MODEL_LOG" \
    && grep -qxF 'Invocando reviewer (modelo: <heredado>)...' "$MODEL_LOG"; then
    pass 'formatea modelo concreto y fallback heredado sin tocar el runner'
else
    fail 'no formatea correctamente modelo concreto/heredado'
fi
rm -f "$MODEL_LOG"

echo '[regresion] invocacion ejecutable de run_agent'
REGRESSION_TMP="$(mktemp -d -t mefisto-tooling-run-agent)"
REGRESSION_ARGS="$REGRESSION_TMP/runner.args"
REGRESSION_CALLS="$REGRESSION_TMP/runner.calls"
REGRESSION_CASE="$REGRESSION_TMP/run-agent-case.sh"
export REGRESSION_ARGS REGRESSION_CALLS REGRESSION_TMP ROOT
cat > "$REGRESSION_TMP/run-agent-double" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' invoked >> "$REGRESSION_CALLS"
printf '%s\n' "$@" > "$REGRESSION_ARGS"
while [ "$#" -gt 0 ]; do
    case "$1" in
        --event-log) printf '%s\n' '{"type":"run.completed","status":"success","session_id":null,"denials":0,"error":null}' > "$2"; shift 2 ;;
        *) shift ;;
    esac
done
EOF
chmod +x "$REGRESSION_TMP/run-agent-double"
{
    printf '%s\n' 'set -eu'
    # Extrae y ejecuta la funcion publicada real bajo nounset. Los dobles solo
    # reemplazan sus dependencias externas; el argv y las rutas los deriva
    # run_agent por si misma.
    awk '/^run_agent\(\) \{/{p=1} p{print} p && /^}/{p=0}' "$PIPELINE"
    cat <<'EOF'
LOG_DIR_ABS="$REGRESSION_TMP/logs"
TIMESTAMP='20260912-120000'
ISSUE_LOG_TAG='1283'
PIPELINE_TMP_DIR="$REGRESSION_TMP/pipeline"
WORKTREE_PATH="$ROOT"
RUN_AGENT_BIN="$REGRESSION_TMP/run-agent-double"
MEFISTO_RUNTIME_RESUELTO='fake'
MEFISTO_AGENT_TIMEOUT_SECONDS=60
EVENTS_LOG_ABS="$REGRESSION_TMP/events.log"
ISSUE_NUM=1283
VARIANT_LABEL_JSON='null'
HARNESS_IDENTITY_JSON='{}'
MODEL_WRITER=''
MODEL_REVIEWER=''
EFFORT_WRITER=''
EFFORT_REVIEWER=''
PIPELINE_OWN_WRITES=(':!.mefisto/pipeline')
mkdir -p "$LOG_DIR_ABS" "$PIPELINE_TMP_DIR"
log() { :; }
warn() { :; }
abort() { return 1; }
update_status() { :; }
log_agent_model_invocation() { :; }
mefisto_state_path() { mkdir -p "$REGRESSION_TMP/state/$(dirname "$1")"; printf '%s\n' "$REGRESSION_TMP/state/$1"; }
derive_stage_log_from_stream() { :; }
compute_stage_metrics() { printf '{}'; }
enrich_tooling_stage_metrics() { printf '%s' "$2"; }
agent_events_denials() { printf '0'; }
agent_events_completed_successfully() { return 0; }
classify_neutral_agent_failure() { printf 'UNKNOWN'; }
agent_failure_is_holdable() { return 1; }
run_agent '1' 'writer' 'prompt de regresion'
EOF
} > "$REGRESSION_CASE"
EXPECTED_EVENT_LOG="$REGRESSION_TMP/logs/tooling-stage-1-writer-20260912-120000-issue-1283-attempt-1.events.jsonl"
EXPECTED_PROMPT="$REGRESSION_TMP/pipeline/1-writer.prompt.md"
EXPECTED_SYSTEM="$REGRESSION_TMP/pipeline/1-writer.system.md"
EXPECTED_ARGS="$REGRESSION_TMP/expected.args"
printf '%s\n' \
    --runtime fake \
    --agent tooling-writer \
    --cwd "$ROOT" \
    --prompt-file "$EXPECTED_PROMPT" \
    --system-file "$EXPECTED_SYSTEM" \
    --event-log "$EXPECTED_EVENT_LOG" \
    --events-log "$REGRESSION_TMP/events.log" \
    --redact-observability \
    --timeout 60 > "$EXPECTED_ARGS"

DEFAULT_BASH="$(command -v bash)"
for REGRESSION_BASH in "$DEFAULT_BASH" /bin/bash; do
    [ -x "$REGRESSION_BASH" ] || continue
    : > "$REGRESSION_CALLS"
    rm -f "$REGRESSION_ARGS" "$EXPECTED_PROMPT" "$EXPECTED_SYSTEM" "$EXPECTED_EVENT_LOG"
    if "$REGRESSION_BASH" "$REGRESSION_CASE" \
        && [ "$(wc -l < "$REGRESSION_CALLS" | tr -d ' ')" -eq 1 ] \
        && cmp -s "$EXPECTED_ARGS" "$REGRESSION_ARGS" \
        && [ "$(cat "$EXPECTED_PROMPT")" = 'prompt de regresion' ] \
        && [ -f "$EXPECTED_SYSTEM" ] && [ -f "$EXPECTED_EVENT_LOG" ]; then
        pass "run_agent deriva el argv exacto y hace una invocacion bajo nounset ($("$REGRESSION_BASH" --version | awk 'NR == 1 { print $1, $2, $3, $4 }'))"
    else
        fail "run_agent no invoca el runner neutral esperado bajo nounset con $REGRESSION_BASH"
    fi
    [ "$REGRESSION_BASH" != /bin/bash ] || break
done
rm -rf "$REGRESSION_TMP"

echo '[effort] resolucion con el adaptador fake y --effort recibido por cada agente (issue #2500)'
EFF_TMP="$(mktemp -d -t mefisto-tooling-effort)"
cat > "$EFF_TMP/run-agent-double" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$EFF_TMP/args.$EFF_AGENT_TAG"
while [ "$#" -gt 0 ]; do
    case "$1" in
        --event-log) printf '%s\n' '{"type":"run.completed","status":"success","session_id":null,"denials":0,"error":null}' > "$2"; shift 2 ;;
        *) shift ;;
    esac
done
EOF
chmod +x "$EFF_TMP/run-agent-double"
cat > "$EFF_TMP/models.json" <<'EOF'
{"fake":{"efforts":{"levels":{"light":"n-light","standard":"n-standard","thorough":"n-thorough"},"agents":{"tooling-reviewer":"thorough"}}}}
EOF
export EFF_TMP
# eff_case <models-file> <writer|reviewer>: resuelve el effort con el helper
# comun y ejecuta run_agent real; deja el argv del runner en args.<rol>.
eff_case() {
    local models="$1" role="$2" agent_id
    case "$role" in reviewer) agent_id=tooling-reviewer ;; *) agent_id=tooling-writer ;; esac
    {
        printf '%s\n' 'set -eu'
        awk '/^run_agent\(\) \{/{p=1} p{print} p && /^}/{p=0}' "$PIPELINE"
        cat <<'EOS'
source "$ROOT/scripts/_pipeline-common.sh"
source "$ROOT/src/runtime/lib/mefisto-models.sh"
LOG_DIR_ABS="$EFF_TMP/logs"; TIMESTAMP='20261110-000000'; ISSUE_LOG_TAG='2500'
PIPELINE_TMP_DIR="$EFF_TMP/pipeline"; WORKTREE_PATH="$ROOT"
RUN_AGENT_BIN="$EFF_TMP/run-agent-double"
MEFISTO_RUNTIME_RESUELTO='fake'; MEFISTO_AGENT_TIMEOUT_SECONDS=60
EVENTS_LOG_ABS="$EFF_TMP/events.log"; ISSUE_NUM=2500; VARIANT_LABEL_JSON='null'; HARNESS_IDENTITY_JSON='{}'
MODEL_WRITER=''; MODEL_REVIEWER=''
PIPELINE_OWN_WRITES=(':!.mefisto/pipeline')
mkdir -p "$LOG_DIR_ABS" "$PIPELINE_TMP_DIR"
log() { :; }; warn() { :; }; abort() { return 1; }; update_status() { :; }; log_agent_model_invocation() { :; }
mefisto_state_path() { mkdir -p "$EFF_TMP/state/$(dirname "$1")"; printf '%s\n' "$EFF_TMP/state/$1"; }
derive_stage_log_from_stream() { :; }; compute_stage_metrics() { printf '{}'; }
enrich_tooling_stage_metrics() { printf '%s' "$2"; }; agent_events_denials() { printf '0'; }
agent_events_completed_successfully() { return 0; }; classify_neutral_agent_failure() { printf 'UNKNOWN'; }
agent_failure_is_holdable() { return 1; }
EFFORT_WRITER=''; EFFORT_REVIEWER=''
EOS
        printf 'CONSUMER_MODELS_FILE=%q\n' "$models"
        printf 'resolve_pipeline_agent_effort %q %q\n' "$role" "$agent_id"
        if [ "$role" = reviewer ]; then
            printf '%s\n' 'EFFORT_REVIEWER="$RESOLVED_PIPELINE_EFFORT"'
        else
            printf '%s\n' 'EFFORT_WRITER="$RESOLVED_PIPELINE_EFFORT"'
        fi
        printf '%s\n' "run_agent '1' '$role' 'prompt effort'"
    } > "$EFF_TMP/case-$role.sh"
    ROOT="$ROOT" EFF_AGENT_TAG="$role" bash "$EFF_TMP/case-$role.sh"
}
if eff_case "$EFF_TMP/ausente.json" writer && eff_case "$EFF_TMP/ausente.json" reviewer \
    && ! grep -qx -- '--effort' "$EFF_TMP/args.writer" && ! grep -qx -- '--effort' "$EFF_TMP/args.reviewer"; then
    pass 'sin mapping ni default: writer y reviewer no reciben --effort (heredan)'
else
    fail 'sin mapping no debia pasarse --effort'
fi
if eff_case "$EFF_TMP/models.json" writer && eff_case "$EFF_TMP/models.json" reviewer \
    && grep -qx -- '--effort' "$EFF_TMP/args.writer" && grep -qx 'n-light' "$EFF_TMP/args.writer" \
    && grep -qx 'n-thorough' "$EFF_TMP/args.reviewer"; then
    pass 'con mapping: writer recibe n-light (de fabrica) y reviewer n-thorough (efforts.agents)'
else
    fail "con mapping: writer=$(tr '\n' ' ' < "$EFF_TMP/args.writer" 2>/dev/null) reviewer=$(tr '\n' ' ' < "$EFF_TMP/args.reviewer" 2>/dev/null)"
fi
rm -rf "$EFF_TMP"

echo '[regresion] contexto acotado del reviewer (issue #1450)'
CTX_TMP="$(mktemp -d -t mefisto-tooling-reviewer-ctx)"
CTX_WT="$CTX_TMP/worktree"
mkdir -p "$CTX_WT"
git -C "$CTX_WT" init -q
git -C "$CTX_WT" config user.email test@example.invalid
git -C "$CTX_WT" config user.name Test
printf 'base\n' > "$CTX_WT/base.txt"
git -C "$CTX_WT" add base.txt
git -C "$CTX_WT" commit -qm base
CTX_SNAPSHOT="$(git -C "$CTX_WT" rev-parse HEAD)"
mkdir -p "$CTX_WT/scaffold"
# Texto, no binario: git no emite contenido para un blob binario, asi que un archivo
# binario grande dejaria el assert de tamano del prompt sin poder de deteccion.
awk 'BEGIN{for(i=0;i<50000;i++) printf "linea %d de contenido generado por el writer para inflar el diff\n", i}' > "$CTX_WT/scaffold/generated.txt"
printf 'contenido nuevo\n' > "$CTX_WT/scaffold/nota.md"
git -C "$CTX_WT" add scaffold/generated.txt scaffold/nota.md
git -C "$CTX_WT" commit -qm 'writer: scaffold grande'
CTX_HEAD="$(git -C "$CTX_WT" rev-parse HEAD)"
CTX_RAW_DIFF_BYTES=$(git -C "$CTX_WT" diff "$CTX_SNAPSHOT"..HEAD | wc -c | tr -d ' ')
[ "$CTX_RAW_DIFF_BYTES" -ge 3145728 ] \
    || fail "premisa invalida: el diff completo mide ${CTX_RAW_DIFF_BYTES} bytes (< 3 MB), el caso no discriminaria el contexto acotado"
CTX_LOGS="$CTX_TMP/logs"
CTX_PIPELINE_TMP="$CTX_TMP/pipeline"
mkdir -p "$CTX_LOGS" "$CTX_PIPELINE_TMP"
export CTX_TMP CTX_WT CTX_SNAPSHOT CTX_LOGS CTX_PIPELINE_TMP

cat > "$CTX_TMP/run-agent-double" <<'EOF'
#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do
    case "$1" in
        --event-log) printf '%s\n' '{"type":"run.completed","status":"success","session_id":null,"denials":0,"error":null}' > "$2"; shift 2 ;;
        *) shift ;;
    esac
done
EOF
chmod +x "$CTX_TMP/run-agent-double"

{
    printf '%s\n' 'set -eu'
    awk '/^run_agent\(\) \{/{p=1} p{print} p && /^}/{p=0}' "$PIPELINE"
    cat <<'EOF'
LOG_DIR_ABS="$CTX_LOGS"
TIMESTAMP='20260918-000000'
ISSUE_LOG_TAG='1450'
PIPELINE_TMP_DIR="$CTX_PIPELINE_TMP"
WORKTREE_PATH="$CTX_WT"
SNAPSHOT_COMMIT="$CTX_SNAPSHOT"
RUN_AGENT_BIN="$CTX_TMP/run-agent-double"
MEFISTO_RUNTIME_RESUELTO='fake'
MEFISTO_AGENT_TIMEOUT_SECONDS=60
EVENTS_LOG_ABS="$CTX_TMP/events.log"
ISSUE_NUM=1450
VARIANT_LABEL_JSON='null'
HARNESS_IDENTITY_JSON='{}'
HARNESS_PROJECT_NAME='proyecto-consumidor-test'
ISSUE_CONTEXT='# Issue de prueba con contexto minimo'
MODEL_WRITER=''
MODEL_REVIEWER=''
EFFORT_WRITER=''
EFFORT_REVIEWER=''
PIPELINE_OWN_WRITES=(':!.mefisto/pipeline')
mkdir -p "$LOG_DIR_ABS" "$PIPELINE_TMP_DIR"
log() { :; }
warn() { :; }
abort() { return 1; }
update_status() { :; }
log_agent_model_invocation() { :; }
mefisto_state_path() { mkdir -p "$CTX_TMP/state/$(dirname "$1")"; printf '%s\n' "$CTX_TMP/state/$1"; }
derive_stage_log_from_stream() { :; }
compute_stage_metrics() { printf '{}'; }
enrich_tooling_stage_metrics() { printf '%s' "$2"; }
agent_events_denials() { printf '0'; }
agent_events_completed_successfully() { return 0; }
classify_neutral_agent_failure() { printf 'UNKNOWN'; }
agent_failure_is_holdable() { return 1; }
EOF
    awk '/^    WRITER_HEAD_SHA=\$\(git -C "\$WORKTREE_PATH" rev-parse HEAD\)$/{p=1} p{print} p && /^    run_agent "2" "reviewer" "\$STAGE2_PROMPT"$/{exit}' "$PIPELINE"
} > "$CTX_TMP/case.sh"

if bash "$CTX_TMP/case.sh"; then
    CTX_PROMPT="$CTX_PIPELINE_TMP/2-reviewer.prompt.md"
    CTX_SIZE=$(wc -c < "$CTX_PROMPT" 2>/dev/null | tr -d ' ')
    if [ -f "$CTX_PROMPT" ] && [ -n "$CTX_SIZE" ] && [ "$CTX_SIZE" -lt 65536 ] \
        && grep -Fq "$CTX_SNAPSHOT" "$CTX_PROMPT" \
        && grep -Fq "$CTX_HEAD" "$CTX_PROMPT" \
        && grep -Fq 'scaffold/generated.txt' "$CTX_PROMPT" \
        && grep -Fq 'scaffold/nota.md' "$CTX_PROMPT" \
        && ! grep -Fq 'diff --git' "$CTX_PROMPT" \
        && ! grep -Fq '@@' "$CTX_PROMPT"; then
        pass "prompt del reviewer acotado a SHA/stat/rutas: ${CTX_SIZE} bytes frente a un diff crudo del writer de ${CTX_RAW_DIFF_BYTES} bytes"
    else
        fail "prompt del reviewer no cumple el contrato acotado (tamano=${CTX_SIZE:-desconocido})"
    fi
else
    fail 'la construccion del prompt de Stage 2 (reviewer) fallo'
fi
rm -rf "$CTX_TMP"

echo '[contrato] helpers JSONL'
# shellcheck source=/dev/null
source "$ROOT/scripts/_pipeline-common.sh"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
printf '%s\n' '{"type":"run.failed","status":"failed","session_id":"s 1","denials":2,"resets_at":"2030-01-01T00:00:00Z","error":{"kind":"rate_limit"}}' > "$TMP"
[ "$(agent_events_session_id "$TMP")" = 's 1' ] && pass 'lee session_id' || fail 'no lee session_id'
[ "$(agent_events_denials "$TMP")" = 2 ] && pass 'lee denials' || fail 'no lee denials'
[ "$(agent_events_resets_at "$TMP")" = '2030-01-01T00:00:00Z' ] && pass 'lee resets_at raiz' || fail 'no lee resets_at raiz'
[ "$(classify_neutral_agent_failure 1 "$TMP")" = RATE_LIMIT ] && pass 'clasifica error.kind' || fail 'no clasifica error.kind'
if agent_events_completed_successfully "$TMP"; then fail 'un terminal fallido no es exito'; else pass 'rechaza terminal fallido'; fi
printf '%s\n' '{"type":"run.completed","status":"success","session_id":null,"denials":0,"error":null}' > "$TMP"
if agent_events_completed_successfully "$TMP"; then pass 'acepta run.completed success'; else fail 'no acepta run.completed success'; fi

printf '\nResultado: %s PASS, %s FAIL\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
