#!/usr/bin/env bash
# test-agent-resume.sh -- Tests de la reanudacion de sesion tras un hold
# (issue #968).
#
# Contexto: el hold de #967 ya evitaba abortar ante RATE_LIMIT/
# PROVIDER_UNAVAILABLE persistente, pero el intento siguiente repetia el
# stage COMPLETO desde el prompt original -- tirando a la basura todo lo que
# el agente ya habia razonado y escrito en la sesion truncada. Este issue
# hace que, tras esperar, el proximo intento REANUDE esa misma sesion (via
# --resume-session, CA-1/CA-2) en vez de arrancar una nueva, salvo en tres
# casos exactos que degradan a "stage desde cero" con un aviso explicito
# (CA-4): sin session_id en el terminal muerto, runtime sin soporte de
# reanudacion, o la sesion reanudada vuelve a morir sin dejar el resumen del
# stage (ese ultimo caso degrada de forma PERMANENTE para el resto de la
# corrida, sin usar --fork para bifurcar a un id nuevo).
#
# Casos cubiertos:
#   [pre] las funciones nuevas estan definidas
#   [pre-2] runtime_supports_resume DESCUBRE el adaptador en
#         $MEFISTO_RUNTIME_LIB_DIR (no enumera runtimes por nombre) y degrada
#         a "sin soporte" si falta la lib o la capability
#   [A]   agent_events_session_id: lee `session_id` del terminal, cadena
#         vacia cuando falta/es null
#   [B]   CA-3: tras un hold, el intento siguiente reanuda -- --resume-session
#         con el id del terminal muerto, el prompt es el mensaje corto de
#         continuacion (nunca el original), rastro "[hold][resume]" en
#         events.log y CA-6 (constancia de que hubo reanudacion)
#   [C]   CA-4 caso (a): terminal sin session_id -> reintenta sin reanudar
#   [D]   CA-4 caso (b): runtime sin runtime_<id>_supports_resume -> reintenta
#         sin reanudar
#   [E]   CA-4 caso (c): la sesion reanudada vuelve a morir sin dejar el
#         resumen -> degrada de forma PERMANENTE (el intento siguiente, pese
#         a tener session_id disponible, ya no reanuda)
#   [F]   CA-5: el techo de hold agotado sigue abortando fail-loud igual que
#         antes de #968 (la reanudacion no relaja ese gate)
#
# Uso: .claude/scripts/tests/test-agent-resume.sh
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

INTERNAL_PIPELINE="$REPO_ROOT/src/internal/scripts/mefisto-tooling-pipeline.sh"

# extract_fn <function_name> <file> -- mismo patron que test-agent-hold.sh
extract_fn() {
    local name="$1" file="$2"
    awk -v fn="$name" '$0 ~ "^"fn"\\(\\) \\{" {p=1} p{print} p && /^}/{p=0}' "$file"
}

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# make_runtime_lib <dir> <yes|no> -- escribe en <dir> un runtime-claude.sh de
# prueba. Con "yes" define runtime_claude_supports_resume; con "no" lo omite
# a proposito (el caso del adaptador de un runtime que todavia no implemento
# la capability). Es el seam que documenta el contrato: el pipeline DESCUBRE
# el adaptador en $MEFISTO_RUNTIME_LIB_DIR -- no enumera runtimes por nombre
# (MEF-ADR-0049/0050) -- asi que un test lo apunta a un directorio temporal
# con adaptadores de prueba en vez de redefinir funciones a mano.
make_runtime_lib() {
    local dir="$1" supports="$2"
    mkdir -p "$dir"
    {
        echo '#!/usr/bin/env bash'
        echo 'runtime_claude_build_cmd() { MEFISTO_RUNTIME_CMD=(true); }'
        echo 'runtime_claude_translate() { :; }'
        [ "$supports" = "yes" ] && echo 'runtime_claude_supports_resume() { return 0; }'
    } > "$dir/runtime-claude.sh"
}

# -------- Bloque pre --------

echo "[pre] Las funciones nuevas estan definidas"
for fn in agent_events_session_id; do
    if declare -F "$fn" >/dev/null; then
        pass "$fn definida (_mefisto-common.sh)"
    else
        fail "$fn NO definida"
    fi
done

eval "$(extract_fn runtime_supports_resume "$INTERNAL_PIPELINE")"
if declare -F runtime_supports_resume >/dev/null; then
    pass "runtime_supports_resume extraida de mefisto-tooling-pipeline.sh"
else
    fail "runtime_supports_resume NO se pudo extraer"
fi

eval "$(extract_fn run_agent "$INTERNAL_PIPELINE")"
if declare -F run_agent >/dev/null; then
    pass "run_agent extraida de mefisto-tooling-pipeline.sh"
else
    fail "run_agent NO se pudo extraer"
fi

# -------- Bloque pre-2: runtime_supports_resume DESCUBRE el adaptador --------
#
# MEF-ADR-0049/0050: el pipeline no enumera runtimes por nombre -- resuelve
# "$MEFISTO_RUNTIME_LIB_DIR/runtime-<id>.sh". Un runtime nuevo queda cubierto
# con solo aportar su lib, y uno sin lib (o sin la capability) degrada a
# "sin soporte" en vez de romper.
echo ""
echo "[pre-2] runtime_supports_resume resuelve el adaptador por \$MEFISTO_RUNTIME_LIB_DIR"
make_runtime_lib "$TMP/pre-yes" yes
make_runtime_lib "$TMP/pre-no" no

MEFISTO_RUNTIME_LIB_DIR="$TMP/pre-yes"
if runtime_supports_resume claude; then
    pass "pre-2a: lib con la capability -> soportado"
else
    fail "pre-2a: la lib define runtime_claude_supports_resume y no se detecto"
fi
if runtime_supports_resume runtime-inexistente; then
    fail "pre-2b: un runtime sin lib deberia degradar a no soportado"
else
    pass "pre-2b: runtime sin lib -> no soportado, sin romper (conjunto abierto)"
fi

MEFISTO_RUNTIME_LIB_DIR="$TMP/pre-no"
if runtime_supports_resume claude; then
    fail "pre-2c: lib SIN la capability deberia degradar a no soportado"
else
    pass "pre-2c: lib sin la capability -> no soportado (MEF-ADR-0050)"
fi

if ! declare -F runtime_claude_build_cmd >/dev/null 2>&1; then
    pass "pre-2d: consultar la capability NO importo runtime_claude_build_cmd al namespace del caller"
else
    fail "pre-2d: runtime_claude_build_cmd se filtro al namespace del caller (deberia cargarse en un subshell)"
fi

# -------- Bloque A: agent_events_session_id --------

echo ""
echo "[A] agent_events_session_id lee session_id del terminal"

EVENTS_WITH_SESSION="$TMP/events-with-session.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-09-06T22:00:05Z","status":"failed","runtime":"claude","model":null,"session_id":"sess-abc","duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"rate_limit","detail":"ventana agotada"},"resets_at":null}' > "$EVENTS_WITH_SESSION"

EVENTS_NULL_SESSION="$TMP/events-null-session.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-09-06T22:00:05Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"rate_limit","detail":"429"},"resets_at":null}' > "$EVENTS_NULL_SESSION"

got=$(agent_events_session_id "$EVENTS_WITH_SESSION")
if [ "$got" = "sess-abc" ]; then
    pass "A-1: session_id poblado se lee tal cual"
else
    fail "A-1: se esperaba 'sess-abc', se obtuvo '$got'"
fi

got=$(agent_events_session_id "$EVENTS_NULL_SESSION")
if [ -z "$got" ]; then
    pass "A-2: session_id null da cadena vacia"
else
    fail "A-2: se esperaba cadena vacia, se obtuvo '$got'"
fi

got=$(agent_events_session_id "$TMP/no-existe.jsonl")
if [ -z "$got" ]; then
    pass "A-3: archivo inexistente da cadena vacia (nunca aborta)"
else
    fail "A-3: se esperaba cadena vacia, se obtuvo '$got'"
fi

# -------- Arneses compartidos con test-agent-hold.sh --------

setup_run_agent_env() {
    local wt="$1"

    LOG_DIR_ABS="$TMP/logs"; PIPELINE_DIR_ABS="$TMP/pipeline"
    mkdir -p "$LOG_DIR_ABS" "$PIPELINE_DIR_ABS/metrics"
    EVENTS_LOG_ABS="$TMP/events.log"; : > "$EVENTS_LOG_ABS"
    TIMESTAMP="testts"; ISSUE_NUM="999"
    ISSUE_LOG_TAG="$ISSUE_NUM"
    WORKTREE_PATH="$wt"; SNAPSHOT_COMMIT="HEAD"
    RED=""; NC=""
    AGENT_WR_RES=""; AGENT_RV_RES=""; AGENT_WR_DUR=0; AGENT_RV_DUR=0
    AGENT_WR_METRICS_JSON=""; AGENT_RV_METRICS_JSON=""
    LAST_AGENT_DURATION=0; LAST_AGENT_METRICS_JSON=""; LAST_AGENT_HOLD_SECONDS=0

    SCRIPT_DIR="$REPO_ROOT/src/internal/scripts"
    RUNTIME_LIB_DIR="$REPO_ROOT/src/runtime/lib"
    RUN_AGENT_BIN_DEFAULT="$REPO_ROOT/src/runtime/mefisto-run-agent.sh"
    MEFISTO_RUNTIME_RESUELTO="claude"
    MODEL_WRITER=""
    MODEL_REVIEWER=""
    # Effort por rol (issue #2499): vacio = heredar, run_agent omite --effort.
    EFFORT_WRITER=""
    EFFORT_REVIEWER=""

    # El adaptador de prueba vive en un directorio propio por bloque: asi el
    # test ejercita el DESCUBRIMIENTO real de runtime_supports_resume, no una
    # funcion inyectada en su namespace.
    MEFISTO_RUNTIME_LIB_DIR="$TMP/rt-lib-$RANDOM-$RANDOM"
    export MEFISTO_RUNTIME_LIB_DIR
    make_runtime_lib "$MEFISTO_RUNTIME_LIB_DIR" yes

    # Reintento corto de #534 fuera de juego, igual que test-agent-hold.sh:
    # este archivo prueba la reanudacion sobre el hold, no el backoff corto.
    export MEFISTO_AGENT_MAX_ATTEMPTS=1
    export MEFISTO_AGENT_RETRY_BACKOFF_SECONDS=0
    MEFISTO_AGENT_TIMEOUT_SECONDS=1800
    export MEFISTO_HOLD_MAX_SECONDS=3600
    export MEFISTO_HOLD_PROBE_SECONDS=1

    log()  { :; }
    warn() { :; }
    update_status() { :; }
    abort() { echo "ABORTED: $*" >> "$TMP/aborted.txt"; return 1; }
    derive_stage_log_from_stream() { :; }
    compute_stage_metrics() { echo "null"; }
    agent_work_is_trustworthy() { return 1; }
}

new_wt() {
    local wt="$TMP/wt-$RANDOM-$RANDOM"
    mkdir -p "$wt"
    git -C "$wt" init -q
    git -C "$wt" config user.email t@t.t
    git -C "$wt" config user.name t
    echo "base" > "$wt/base.txt"
    git -C "$wt" add -A && git -C "$wt" commit -qm base
    echo "$wt"
}

attempts_made() { wc -l < "$TMP/attempts.txt" | tr -d ' '; }

write_rate_limit_event() {
    # write_rate_limit_event <file> <session_id-o-cadena-vacia>
    local file="$1" sid="$2" sid_json="null"
    [ -n "$sid" ] && sid_json="\"$sid\""
    printf '%s\n' "{\"v\":1,\"type\":\"run.failed\",\"ts\":\"2026-09-06T22:00:05Z\",\"status\":\"failed\",\"runtime\":\"claude\",\"model\":null,\"session_id\":$sid_json,\"duration_ms\":100,\"tokens\":{\"input\":null,\"output\":null},\"cost_usd\":null,\"turns\":null,\"denials\":null,\"ttft_ms\":null,\"api_duration_ms\":null,\"error\":{\"kind\":\"rate_limit\",\"detail\":\"429\"},\"resets_at\":null}" > "$file"
}

EVENTS_OK="$TMP/events-ok.jsonl"
printf '%s\n' '{"v":1,"type":"run.completed","ts":"2026-09-06T22:00:10Z","status":"success","runtime":"claude","model":"claude-sonnet-5","session_id":"sess-final","duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":null}' > "$EVENTS_OK"

# resume_stub <script_path> <spec_dir> -- genera un runner falso que, en cada
# invocacion, vuelca TODO su argv relevante a "<spec_dir>/attempt-N.info"
# (session_id/prompt_file recibidos) y decide exito/fallo leyendo
# "<spec_dir>/attempt-N.plan" (dos lineas: ruta del events-fixture a copiar,
# exit code). Un intento sin .plan usa EVENTS_OK/0 (default: exito).
make_resume_stub() {
    local script="$1" spec_dir="$2" default_events="$3"
    mkdir -p "$spec_dir"
    cat > "$script" <<EOF
#!/usr/bin/env bash
set -u
echo "x" >> "$TMP/attempts.txt"
n=\$(wc -l < "$TMP/attempts.txt" | tr -d ' ')
event_log="" resume_session="" prompt_file=""
while [ \$# -gt 0 ]; do
    case "\$1" in
        --event-log) event_log="\$2"; shift 2 ;;
        --resume-session) resume_session="\$2"; shift 2 ;;
        --prompt-file) prompt_file="\$2"; shift 2 ;;
        *) shift ;;
    esac
done
{
    echo "resume_session=\$resume_session"
    echo "prompt_file=\$prompt_file"
} > "$spec_dir/attempt-\$n.info"
plan="$spec_dir/attempt-\$n.plan"
if [ -f "\$plan" ]; then
    events_src=\$(sed -n '1p' "\$plan")
    exit_code=\$(sed -n '2p' "\$plan")
else
    events_src="$default_events"
    exit_code="0"
fi
cp "\$events_src" "\$event_log"
exit "\$exit_code"
EOF
    chmod +x "$script"
}

# -------- Bloque B: CA-3, reanuda tras el hold --------

echo ""
echo "[B] CA-3: tras un hold, el intento siguiente reanuda la sesion muerta"

WT_B=$(new_wt)
setup_run_agent_env "$WT_B"

EVENTS_B1="$TMP/events-b1.jsonl"
write_rate_limit_event "$EVENTS_B1" "sess-b1"

: > "$TMP/attempts.txt"
SPEC_B="$TMP/spec-b"
make_resume_stub "$TMP/stub-b.sh" "$SPEC_B" "$EVENTS_OK"
{ echo "$EVENTS_B1"; echo "1"; } > "$SPEC_B/attempt-1.plan"
export MEFISTO_RUN_AGENT_BIN="$TMP/stub-b.sh"

ORIGINAL_PROMPT_TEXT="prompt original completo del stage 1"
rc=0
run_agent "1" "writer" "$ORIGINAL_PROMPT_TEXT" >/dev/null 2>&1 || rc=$?

if [ "$rc" -eq 0 ] && [ "$(attempts_made)" = "2" ]; then
    pass "B-1: el stage termina bien en 2 intentos (1 fallo + 1 reanudado con exito)"
else
    fail "B-1: se esperaba exito en 2 intentos (rc=$rc, attempts=$(attempts_made))"
fi

if [ -f "$SPEC_B/attempt-2.info" ] && grep -qxF "resume_session=sess-b1" "$SPEC_B/attempt-2.info"; then
    pass "B-2: el 2do intento recibio --resume-session sess-b1 (el id del terminal muerto)"
else
    fail "B-2: el 2do intento no recibio el resume_session_id esperado: $(cat "$SPEC_B/attempt-2.info" 2>/dev/null)"
fi

ATTEMPT2_PROMPT_FILE=$(sed -n 's/^prompt_file=//p' "$SPEC_B/attempt-2.info" 2>/dev/null)
if [ -n "$ATTEMPT2_PROMPT_FILE" ] && [[ "$ATTEMPT2_PROMPT_FILE" == *.resume-prompt.md ]]; then
    pass "B-3: el 2do intento usa el prompt de CONTINUACION (*.resume-prompt.md), nunca el original"
else
    fail "B-3: el prompt-file del 2do intento no es el de continuacion: '$ATTEMPT2_PROMPT_FILE'"
fi

if [ -f "$ATTEMPT2_PROMPT_FILE" ] && ! grep -qF "$ORIGINAL_PROMPT_TEXT" "$ATTEMPT2_PROMPT_FILE"; then
    pass "B-4: el prompt de continuacion NO reenvia el texto del prompt original completo"
else
    fail "B-4: el prompt de continuacion parece contener el prompt original: $(cat "$ATTEMPT2_PROMPT_FILE" 2>/dev/null)"
fi

ATTEMPT1_PROMPT_FILE=$(sed -n 's/^prompt_file=//p' "$SPEC_B/attempt-1.info" 2>/dev/null)
if [ "$ATTEMPT1_PROMPT_FILE" != "$ATTEMPT2_PROMPT_FILE" ]; then
    pass "B-5: el 1er intento (sin reanudar) usa un prompt-file distinto al de continuacion"
else
    fail "B-5: el 1er intento uso el mismo prompt-file que el reanudado"
fi

if grep -q '\[hold\]\[resume\] writer: reanudando sesion sess-b1' "$EVENTS_LOG_ABS"; then
    pass "B-6: events.log deja el rastro [hold][resume] de la reanudacion"
else
    fail "B-6: events.log no tiene la linea de reanudacion esperada"
fi

if grep -q '\[hold\]\[resume\] writer: stage completado tras reanudar sesion' "$EVENTS_LOG_ABS"; then
    pass "B-7 (CA-6): events.log deja constancia de que el stage se completo tras reanudar"
else
    fail "B-7 (CA-6): falta la linea de cierre que distingue un stage reanudado de uno limpio"
fi

if [ "${LAST_AGENT_RESUMED:-}" = true ]; then
    pass "B-8 (CA-6): LAST_AGENT_RESUMED=true -- la constancia llega al resumen del stage que va al cuerpo del PR (sobrevive al worktree, a diferencia de events.log)"
else
    fail "B-8 (CA-6): LAST_AGENT_RESUMED deberia ser true, fue '${LAST_AGENT_RESUMED:-<unset>}'"
fi

# -------- Bloque C: CA-4 caso (a), sin session_id --------

echo ""
echo "[C] CA-4 caso (a): terminal sin session_id -- reintenta sin reanudar"

WT_C=$(new_wt)
setup_run_agent_env "$WT_C"

EVENTS_C1="$TMP/events-c1.jsonl"
write_rate_limit_event "$EVENTS_C1" ""

: > "$TMP/attempts.txt"
SPEC_C="$TMP/spec-c"
make_resume_stub "$TMP/stub-c.sh" "$SPEC_C" "$EVENTS_OK"
{ echo "$EVENTS_C1"; echo "1"; } > "$SPEC_C/attempt-1.plan"
export MEFISTO_RUN_AGENT_BIN="$TMP/stub-c.sh"

rc=0
run_agent "1" "writer" "prompt" >/dev/null 2>&1 || rc=$?

if [ "$rc" -eq 0 ] && [ -f "$SPEC_C/attempt-2.info" ] && grep -qxF "resume_session=" "$SPEC_C/attempt-2.info"; then
    pass "C-1: sin session_id en el terminal muerto, el 2do intento NO reanuda"
else
    fail "C-1: se esperaba un 2do intento sin resume_session (rc=$rc): $(cat "$SPEC_C/attempt-2.info" 2>/dev/null)"
fi

if grep -q 'CA-4a' "$EVENTS_LOG_ABS" && grep -q 'sin session_id en el terminal' "$EVENTS_LOG_ABS"; then
    pass "C-2: events.log nombra el motivo exacto del caso (a)"
else
    fail "C-2: events.log no nombra el caso (a) esperado"
fi

if [ "${LAST_AGENT_RESUMED:-}" = false ]; then
    pass "C-3 (CA-6): LAST_AGENT_RESUMED=false -- un stage degradado no se reporta como reanudado"
else
    fail "C-3 (CA-6): LAST_AGENT_RESUMED deberia ser false, fue '${LAST_AGENT_RESUMED:-<unset>}'"
fi

# -------- Bloque D: CA-4 caso (b), runtime sin soporte --------

echo ""
echo "[D] CA-4 caso (b): runtime sin runtime_<id>_supports_resume -- reintenta sin reanudar"

WT_D=$(new_wt)
setup_run_agent_env "$WT_D"
# A proposito: el adaptador de prueba de este bloque NO define
# runtime_claude_supports_resume -- runtime_supports_resume degrada a "sin
# soporte" cuando la capability falta en la lib del runtime activo
# (MEF-ADR-0050).
make_runtime_lib "$MEFISTO_RUNTIME_LIB_DIR" no

EVENTS_D1="$TMP/events-d1.jsonl"
write_rate_limit_event "$EVENTS_D1" "sess-d1"

: > "$TMP/attempts.txt"
SPEC_D="$TMP/spec-d"
make_resume_stub "$TMP/stub-d.sh" "$SPEC_D" "$EVENTS_OK"
{ echo "$EVENTS_D1"; echo "1"; } > "$SPEC_D/attempt-1.plan"
export MEFISTO_RUN_AGENT_BIN="$TMP/stub-d.sh"

rc=0
run_agent "1" "writer" "prompt" >/dev/null 2>&1 || rc=$?

if [ "$rc" -eq 0 ] && [ -f "$SPEC_D/attempt-2.info" ] && grep -qxF "resume_session=" "$SPEC_D/attempt-2.info"; then
    pass "D-1: session_id disponible pero runtime sin soporte -- el 2do intento NO reanuda"
else
    fail "D-1: se esperaba un 2do intento sin resume_session (rc=$rc): $(cat "$SPEC_D/attempt-2.info" 2>/dev/null)"
fi

if grep -q 'CA-4b' "$EVENTS_LOG_ABS" && grep -q "sin soporte de reanudacion" "$EVENTS_LOG_ABS"; then
    pass "D-2: events.log nombra el motivo exacto del caso (b)"
else
    fail "D-2: events.log no nombra el caso (b) esperado"
fi

# -------- Bloque E: CA-4 caso (c), la sesion reanudada vuelve a morir sin resumen --------

echo ""
echo "[E] CA-4 caso (c): la sesion reanudada muere de nuevo sin dejar el resumen -- degrada PERMANENTE"

WT_E=$(new_wt)
setup_run_agent_env "$WT_E"

EVENTS_E1="$TMP/events-e1.jsonl"; write_rate_limit_event "$EVENTS_E1" "sess-e1"
EVENTS_E2="$TMP/events-e2.jsonl"; write_rate_limit_event "$EVENTS_E2" "sess-e2"

: > "$TMP/attempts.txt"
SPEC_E="$TMP/spec-e"
make_resume_stub "$TMP/stub-e.sh" "$SPEC_E" "$EVENTS_OK"
{ echo "$EVENTS_E1"; echo "1"; } > "$SPEC_E/attempt-1.plan"
{ echo "$EVENTS_E2"; echo "1"; } > "$SPEC_E/attempt-2.plan"
export MEFISTO_RUN_AGENT_BIN="$TMP/stub-e.sh"

# SUMMARY_FILE (".mefisto/pipeline/summaries/stage-1-writer.md" dentro del
# worktree) NUNCA se escribe en este escenario -- ni el stub la toca, asi
# que el 2do intento (resumido) muere "sin dejar el resumen" tal cual pide
# el caso (c).
rc=0
run_agent "1" "writer" "prompt" >/dev/null 2>&1 || rc=$?

if [ "$rc" -eq 0 ] && [ "$(attempts_made)" = "3" ]; then
    pass "E-1: el stage termina bien en 3 intentos (1 fallo + 1 reanudado que murio de nuevo + 1 desde cero)"
else
    fail "E-1: se esperaban 3 intentos con exito final (rc=$rc, attempts=$(attempts_made))"
fi

if [ -f "$SPEC_E/attempt-2.info" ] && grep -qxF "resume_session=sess-e1" "$SPEC_E/attempt-2.info"; then
    pass "E-2: el 2do intento SI reanudo (sess-e1), confirmando que el caso (c) ocurre DESPUES de intentar"
else
    fail "E-2: el 2do intento deberia haber reanudado sess-e1: $(cat "$SPEC_E/attempt-2.info" 2>/dev/null)"
fi

if [ -f "$SPEC_E/attempt-3.info" ] && grep -qxF "resume_session=" "$SPEC_E/attempt-3.info"; then
    pass "E-3: el 3er intento NO reanuda -- degradado a stage desde cero pese a que sess-e2 SI estaba disponible"
else
    fail "E-3: el 3er intento no deberia traer resume_session: $(cat "$SPEC_E/attempt-3.info" 2>/dev/null)"
fi

if grep -q 'CA-4c' "$EVENTS_LOG_ABS" && grep -q 'murio de nuevo sin resumen' "$EVENTS_LOG_ABS"; then
    pass "E-4: events.log nombra el motivo exacto del caso (c)"
else
    fail "E-4: events.log no nombra el caso (c) esperado"
fi

# -------- Bloque F: CA-5, el techo de hold agotado sigue abortando igual --------

echo ""
echo "[F] CA-5: el techo de hold agotado aborta fail-loud igual que antes de #968"

WT_F=$(new_wt)
setup_run_agent_env "$WT_F"
export MEFISTO_HOLD_MAX_SECONDS=1
export MEFISTO_HOLD_PROBE_SECONDS=1

EVENTS_F1="$TMP/events-f1.jsonl"; write_rate_limit_event "$EVENTS_F1" "sess-f1"

: > "$TMP/attempts.txt"
SPEC_F="$TMP/spec-f"
make_resume_stub "$TMP/stub-f.sh" "$SPEC_F" "$EVENTS_F1"
for i in $(seq 1 99); do { echo "$EVENTS_F1"; echo "1"; } > "$SPEC_F/attempt-$i.plan"; done
export MEFISTO_RUN_AGENT_BIN="$TMP/stub-f.sh"
: > "$TMP/aborted.txt"

run_agent "1" "writer" "prompt" >/dev/null 2>&1 || true

if [ -s "$TMP/aborted.txt" ] && grep -q "techo de espera agotado" "$TMP/aborted.txt"; then
    pass "F-1: el techo agotado sigue abortando fail-loud con el mismo mensaje que antes de #968"
else
    fail "F-1: no aborto como se esperaba: $(cat "$TMP/aborted.txt" 2>/dev/null)"
fi

# -------- Resumen --------

echo ""
echo "Resultado: $PASS PASS, $FAIL FAIL"
[ "$FAIL" -eq 0 ]
