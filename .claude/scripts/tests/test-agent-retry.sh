#!/usr/bin/env bash
# test-agent-retry.sh -- Tests del reintento con backoff ante fallo transitorio
# del servidor (issue #534, actualizada sobre el JSONL neutral en el issue
# #906, y sobre el runner neutral en el issue #910).
#
# Contexto (medido el 2026-08-05): 6 de 10 intentos de stage murieron con
# 522/529 de api.anthropic.com. El pipeline no reintentaba nunca, asi que cada
# uno tiraba el trabajo del stage entero pese a que el payload del 522 declara
# `"retryable": true, "retry_after": 120`.
#
# classify_agent_failure lee `error.kind`/`error.detail` del
# `<log_base>.events.jsonl` que, desde el issue #910, escribe directo
# mefisto-run-agent.sh (run_agent ya no traduce nada -- ese puente era del
# issue #906 y se retiro). El bloque [A] usa fixtures de JSONL neutral
# escritas a mano (conforme a run-events.schema.json); el bloque [C] ejercita
# run_agent extraido de verdad, con un STUB del runner (apuntado via
# MEFISTO_RUN_AGENT_BIN, en vez de un stub de run_agent_with_watchdog) que
# copia una de esas mismas fixtures al --event-log que run_agent le pasa y
# retorna el exit code pedido -- ejercita el bucle de reintento sin invocar
# ningun CLI real ni depender de la traduccion de ningun adaptador.
#
# Casos cubiertos:
#   [pre] las funciones nuevas existen en _mefisto-common.sh
#   [A]   classify_agent_failure: paridad con la clasificacion anterior, ahora
#         leyendo el JSONL neutral en vez de grepear un log de texto
#   [B]   agent_failure_is_retryable: solo PROVIDER_UNAVAILABLE reintenta
#         (issue #965: reemplaza a la vieja etiqueta API_ERROR_SERVER; RATE_LIMIT,
#         la otra etiqueta nueva del issue, queda deliberadamente fuera)
#   [C]   el bucle de run_agent: reintenta 5xx, respeta el tope, no reintenta
#         los demas tipos, y restaura el worktree solo si entraba limpio -- con
#         el techo de hold en 0 (issue #967: MEFISTO_HOLD_MAX_SECONDS=0 en
#         setup_run_agent_env), asi que un PROVIDER_UNAVAILABLE que agota el
#         tope de reintento corto sigue abortando aqui tal cual antes de #967.
#         La politica de espera (hold) en si -- lo que pasa cuando SI hay
#         presupuesto -- se prueba en test-agent-hold.sh.
#
# Uso: .claude/scripts/tests/test-agent-retry.sh
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
# Desde el issue #910 run_agent no sourcea ni invoca ninguna libreria de
# runtime/modelos: el runtime y el modelo se resuelven en el cuerpo del
# pipeline, antes del worktree, y llegan aqui como variables ya fijadas
# (MEFISTO_RUNTIME_RESUELTO, MODEL_WRITER/MODEL_REVIEWER). Este test solo
# necesita _mefisto-common.sh, que ya esta sourceado arriba.

INTERNAL_PIPELINE="$REPO_ROOT/src/internal/scripts/mefisto-tooling-pipeline.sh"

# extract_fn <function_name> <file> -- mismo patron que test-abort-log-tail.sh
extract_fn() {
    local name="$1" file="$2"
    awk -v fn="$name" '$0 ~ "^"fn"\\(\\) \\{" {p=1} p{print} p && /^}/{p=0}' "$file"
}

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# -------- Bloque pre --------

echo "[pre] Las funciones nuevas estan definidas en _mefisto-common.sh"
for fn in classify_agent_failure agent_failure_is_retryable agent_events_error_kind; do
    if declare -F "$fn" >/dev/null; then
        pass "$fn definida"
    else
        fail "$fn NO definida"
    fi
done

# -------- Bloque A: classify_agent_failure --------

echo ""
echo "[A] classify_agent_failure conserva las etiquetas, ahora desde el JSONL neutral"

# Fixtures inline conforme a run-events.schema.json (issue #906, kinds
# "rate_limit"/"provider_unavailable" agregados en el issue #965): un
# terminal run.completed/run.failed con `error{kind, detail}` estructurado.
# Desde #965 el kind YA viene disambiguado del adaptador -- EVENTS_5XX usa
# "provider_unavailable" (no "api_error") porque asi es como runtime-claude.jq
# clasifica hoy un 529 (ver su elif de `api_error_status | test("^5")`).
EVENTS_5XX="$TMP/events-5xx.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-08-05T10:00:00Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"provider_unavailable","detail":"API Error: 529 Overloaded"}}' > "$EVENTS_5XX"
EVENTS_RATE_LIMIT="$TMP/events-rate-limit.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-08-05T10:00:00Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"rate_limit","detail":"ventana de uso agotada (rateLimitType=five_hour, resetsAt=2026-08-05T15:00:00Z)"},"resets_at":"2026-08-05T15:00:00Z"}' > "$EVENTS_RATE_LIMIT"
EVENTS_4XX="$TMP/events-4xx.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-08-05T10:00:00Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"api_error","detail":"API Error: 400 Bad Request"}}' > "$EVENTS_4XX"
EVENTS_CUT="$TMP/events-cut.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-08-05T10:00:00Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"stream_cut","detail":"Connection closed mid-response"}}' > "$EVENTS_CUT"
EVENTS_PLAIN="$TMP/events-plain.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-08-05T10:00:00Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"nonzero_exit","detail":"stop_reason=? subtype=?"}}' > "$EVENTS_PLAIN"
EVENTS_OK="$TMP/events-ok.jsonl"
printf '%s\n' '{"v":1,"type":"run.completed","ts":"2026-08-05T10:00:00Z","status":"success","runtime":"claude","model":"claude-sonnet-5","session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":null}' > "$EVENTS_OK"
EVENTS_BAD="$TMP/events-bad.jsonl"
printf '%s\n' '{"v":1,"type":"message","ts":"2026-08-05T10:00:00Z","role":"assistant","text":"trabajando"}' > "$EVENTS_BAD"

check_label() {
    local desc="$1" expected="$2"; shift 2
    local got
    got=$(classify_agent_failure "$@")
    if [ "$got" = "$expected" ]; then
        pass "$desc -> $expected"
    else
        fail "$desc: se esperaba '$expected', se obtuvo '$got'"
    fi
}

check_label "A-1: watchdog disparo" \
    "TIMEOUT (99s, exit 1)"                 "true"  "1"   "99" "$EVENTS_BAD"
check_label "A-2: senal con terminal de exito" \
    "SIGNAL_POST_SUCCESS (exit 137, 12s)"   "false" "137" "12" "$EVENTS_OK"
check_label "A-3: senal sin terminal" \
    "SIGNAL_MID_FLIGHT (exit 137, 12s)"     "false" "137" "12" "$EVENTS_BAD"
check_label "A-4: 5xx del proveedor (kind provider_unavailable)" \
    "PROVIDER_UNAVAILABLE (exit 1)"         "false" "1"   "12" "$EVENTS_5XX"
check_label "A-5: 4xx del cliente" \
    "API_ERROR_CLIENT (exit 1)"             "false" "1"   "12" "$EVENTS_4XX"
check_label "A-6: corte de stream" \
    "STREAM_CUT (exit 1)"                   "false" "1"   "12" "$EVENTS_CUT"
check_label "A-7: sin sintoma reconocible" \
    "CLI_ERROR (exit 3)"                    "false" "3"   "12" "$EVENTS_PLAIN"
check_label "A-9: ventana de uso agotada (kind rate_limit, issue #965)" \
    "RATE_LIMIT (exit 1)"                   "false" "1"   "12" "$EVENTS_RATE_LIMIT"
# El orden importa: un TIMEOUT del watchdog gana aunque el terminal traiga un 5xx.
check_label "A-8: TIMEOUT precede al 5xx" \
    "TIMEOUT (99s, exit 1)"                 "true"  "1"   "99" "$EVENTS_5XX"

# -------- Bloque B: agent_failure_is_retryable --------

echo ""
echo "[B] agent_failure_is_retryable: solo el 5xx transitorio se reintenta"

if agent_failure_is_retryable "PROVIDER_UNAVAILABLE (exit 1)"; then
    pass "B-1: PROVIDER_UNAVAILABLE es reintentable"
else
    fail "B-1: PROVIDER_UNAVAILABLE deberia ser reintentable"
fi

# RATE_LIMIT (issue #965) queda deliberadamente FUERA del reintento con
# backoff corto de este bucle: una ventana de 5h agotada no se arregla en
# segundos, hace falta la politica de espera (hold, issue #967) que prueba
# test-agent-hold.sh.
for label in "TIMEOUT (1800s, exit 137)" "API_ERROR_CLIENT (exit 1)" \
             "STREAM_CUT (exit 1)" "CLI_ERROR (exit 3)" \
             "RATE_LIMIT (exit 1)" \
             "SIGNAL_MID_FLIGHT (exit 137, 12s)" "SIGNAL_POST_SUCCESS (exit 137, 12s)" ""; do
    if agent_failure_is_retryable "$label"; then
        fail "B-2: '$label' NO deberia ser reintentable"
    else
        pass "B-2: '${label:-<vacio>}' no se reintenta"
    fi
done

# -------- Bloque C: el bucle de run_agent --------

echo ""
echo "[C] run_agent reintenta el 5xx, respeta el tope y no toca los demas tipos"

# Entorno minimo para ejecutar run_agent extraido, sin invocar ningun CLI ni
# el runner real.
setup_run_agent_env() {
    local wt="$1"

    LOG_DIR_ABS="$TMP/logs"; PIPELINE_DIR_ABS="$TMP/pipeline"
    mkdir -p "$LOG_DIR_ABS" "$PIPELINE_DIR_ABS/metrics"
    EVENTS_LOG_ABS="$TMP/events.log"; : > "$EVENTS_LOG_ABS"
    TIMESTAMP="testts"; ISSUE_NUM="999"
    # ISSUE_LOG_TAG (issue #711): run_agent() ya no nombra los logs de stage
    # con ISSUE_NUM directo, sino con este tag (ISSUE_NUM, o ISSUE_NUM-<label>
    # en modo variante). Sin definirlo aqui, la asignacion de log_base dentro
    # de run_agent referencia una variable sin `set` bajo `set -u` y el
    # proceso entero termina en silencio (nounset sale del shell no
    # interactivo, no solo del comando).
    ISSUE_LOG_TAG="$ISSUE_NUM"
    WORKTREE_PATH="$wt"; SNAPSHOT_COMMIT="HEAD"
    RED=""; NC=""
    AGENT_WR_RES=""; AGENT_RV_RES=""; AGENT_WR_DUR=0; AGENT_RV_DUR=0
    AGENT_WR_METRICS_JSON=""; AGENT_RV_METRICS_JSON=""
    LAST_AGENT_DURATION=0; LAST_AGENT_METRICS_JSON=""

    # run_agent (issue #910) referencia estas bajo `set -u`: SCRIPT_DIR solo se
    # usa para componer el default de RUN_AGENT_BIN/--system-file, y
    # MEFISTO_RUNTIME_RESUELTO viaja tal cual al runner -- ninguno de los dos
    # necesita resolver a algo real porque el stub del runner ignora ambos.
    SCRIPT_DIR="$REPO_ROOT/src/internal/scripts"
    MEFISTO_RUNTIME_RESUELTO="claude"
    # El modelo por stage lo resuelve el pipeline ANTES del worktree (CA-2), no
    # run_agent: aqui basta con fijar el resultado. Vacio = heredar, que es
    # ademas el caso que ejerce la rama sin --model del array del runner.
    MODEL_WRITER=""
    MODEL_REVIEWER=""
    # Effort por rol (issue #2499): vacio = heredar, run_agent omite --effort.
    EFFORT_WRITER=""
    EFFORT_REVIEWER=""

    # Reintentos rapidos: el bucle real espera 120s.
    export MEFISTO_AGENT_MAX_ATTEMPTS=3
    export MEFISTO_AGENT_RETRY_BACKOFF_SECONDS=0
    # Techo de hold en 0 (issue #967): este archivo prueba SOLO el reintento
    # corto de #534 -- con el techo agotado desde el arranque, la rama hold de
    # run_agent rompe el bucle sin dormir en cuanto PROVIDER_UNAVAILABLE agota
    # $MAX_ATTEMPTS, preservando el desenlace de siempre (abort tras el tope).
    # La politica de espera en si se prueba en test-agent-hold.sh.
    export MEFISTO_HOLD_MAX_SECONDS=0
    export MEFISTO_HOLD_PROBE_SECONDS=0
    # run_agent (issue #946) ya no fija el timeout inline -- lee la variable
    # global ya validada por el pipeline. Aqui no hay pipeline real que la
    # valide, asi que hace falta fijarla a mano o run_agent revienta bajo
    # `set -u` (el stub del runner la ignora, igual que MEFISTO_RUNTIME_RESUELTO).
    MEFISTO_AGENT_TIMEOUT_SECONDS=1800

    log()  { :; }
    warn() { :; }
    update_status() { :; }
    abort() { echo "ABORTED: $*" >> "$TMP/aborted.txt"; return 1; }
    derive_stage_log_from_stream() { :; }
    compute_stage_metrics() { echo "null"; }
    agent_work_is_trustworthy() { return 1; }
}

# make_run_agent_stub <events_fail> <events_success> <fail_exit> <failures>
#
# Genera un runner de mentira (MEFISTO_RUN_AGENT_BIN) que falla con
# <events_fail>/<fail_exit> durante los primeros <failures> intentos y luego
# copia <events_success> con exit 0. No invoca ningun CLI real ni traduce
# nada: run_agent ya recibe el JSONL neutral tal cual, como lo dejaria
# mefisto-run-agent.sh. Lleva la cuenta de intentos en disco.
make_run_agent_stub() {
    local events_fail="$1" events_success="$2" fail_exit="$3" failures="$4"
    : > "$TMP/attempts.txt"
    cat > "$TMP/fake-run-agent.sh" <<EOF
#!/usr/bin/env bash
set -u
echo "x" >> "$TMP/attempts.txt"
n=\$(wc -l < "$TMP/attempts.txt" | tr -d ' ')
event_log=""
while [ \$# -gt 0 ]; do
    case "\$1" in
        --event-log) event_log="\$2"; shift 2 ;;
        *) shift ;;
    esac
done
if [ "\$n" -le "$failures" ]; then
    cp "$events_fail" "\$event_log"
    exit "$fail_exit"
else
    cp "$events_success" "\$event_log"
    exit 0
fi
EOF
    chmod +x "$TMP/fake-run-agent.sh"
    export MEFISTO_RUN_AGENT_BIN="$TMP/fake-run-agent.sh"
}

attempts_made() { wc -l < "$TMP/attempts.txt" | tr -d ' '; }

run_case() {
    local desc="$1" fail_events="$2" failures="$3" expected_attempts="$4" expect_ok="$5"

    local wt="$TMP/wt-$RANDOM"
    mkdir -p "$wt"
    git -C "$wt" init -q
    git -C "$wt" config user.email t@t.t
    git -C "$wt" config user.name t
    echo "base" > "$wt/base.txt"
    git -C "$wt" add -A && git -C "$wt" commit -qm base

    setup_run_agent_env "$wt"
    make_run_agent_stub "$fail_events" "$EVENTS_OK" 1 "$failures"

    eval "$(extract_fn run_agent "$INTERNAL_PIPELINE")"

    local rc=0
    run_agent "1" "writer" "prompt de prueba" >/dev/null 2>&1 || rc=$?

    local got
    got=$(attempts_made)
    if [ "$got" = "$expected_attempts" ]; then
        pass "$desc: $got intento(s)"
    else
        fail "$desc: se esperaban $expected_attempts intento(s), hubo $got"
    fi

    if [ "$expect_ok" = "ok" ] && [ "$rc" -ne 0 ]; then
        fail "$desc: se esperaba que el stage saliera bien (rc=$rc)"
    fi
}

run_case "C-1: 5xx transitorio, exito al 2do intento" \
    "$EVENTS_5XX" 1 2 ok
run_case "C-2: 5xx persistente, se detiene en el tope de 3" \
    "$EVENTS_5XX" 9 3 fail
run_case "C-3: 4xx del cliente, no se reintenta" \
    "$EVENTS_4XX" 9 1 fail
run_case "C-4: error generico del CLI, no se reintenta" \
    "$EVENTS_PLAIN" 9 1 fail

# C-5: worktree restaurado entre reintentos cuando entraba limpio.
WT_C5="$TMP/wt-c5"
mkdir -p "$WT_C5"
git -C "$WT_C5" init -q
git -C "$WT_C5" config user.email t@t.t
git -C "$WT_C5" config user.name t
echo "base" > "$WT_C5/base.txt"
git -C "$WT_C5" add -A && git -C "$WT_C5" commit -qm base

setup_run_agent_env "$WT_C5"
: > "$TMP/attempts.txt"
cat > "$TMP/fake-run-agent-c5.sh" <<EOF
#!/usr/bin/env bash
set -u
echo "x" >> "$TMP/attempts.txt"
n=\$(wc -l < "$TMP/attempts.txt" | tr -d ' ')
event_log=""
while [ \$# -gt 0 ]; do
    case "\$1" in
        --event-log) event_log="\$2"; shift 2 ;;
        *) shift ;;
    esac
done
if [ "\$n" -le "1" ]; then
    # El intento que falla deja basura en el worktree.
    echo "a medias" > "$WT_C5/basura.txt"
    echo "modificado" >> "$WT_C5/base.txt"
    cp "$EVENTS_5XX" "\$event_log"
    exit 1
else
    cp "$EVENTS_OK" "\$event_log"
    exit 0
fi
EOF
chmod +x "$TMP/fake-run-agent-c5.sh"
export MEFISTO_RUN_AGENT_BIN="$TMP/fake-run-agent-c5.sh"
eval "$(extract_fn run_agent "$INTERNAL_PIPELINE")"
run_agent "1" "writer" "prompt" >/dev/null 2>&1 || true

if [ ! -f "$WT_C5/basura.txt" ] && [ "$(cat "$WT_C5/base.txt")" = "base" ]; then
    pass "C-5: el worktree limpio se restauro antes del reintento"
else
    fail "C-5: el worktree no se restauro (basura.txt o base.txt modificado sobreviven)"
fi

# C-6: worktree que YA entraba sucio no se resetea (el reset destruiria
# trabajo legitimo del writer sin commitear -- ver HAS_UNSTAGED en stage 1).
WT_C6="$TMP/wt-c6"
mkdir -p "$WT_C6"
git -C "$WT_C6" init -q
git -C "$WT_C6" config user.email t@t.t
git -C "$WT_C6" config user.name t
echo "base" > "$WT_C6/base.txt"
git -C "$WT_C6" add -A && git -C "$WT_C6" commit -qm base
echo "trabajo del writer sin commitear" > "$WT_C6/previo.txt"

setup_run_agent_env "$WT_C6"
make_run_agent_stub "$EVENTS_5XX" "$EVENTS_OK" 1 1
eval "$(extract_fn run_agent "$INTERNAL_PIPELINE")"
run_agent "1" "writer" "prompt" >/dev/null 2>&1 || true

if [ -f "$WT_C6/previo.txt" ]; then
    pass "C-6: el trabajo previo sin commitear sobrevivio al reintento"
else
    fail "C-6: el reintento borro trabajo legitimo previo al stage"
fi

# C-7: cada reintento queda registrado en events.log.
if grep -q "REINTENTO writer: PROVIDER_UNAVAILABLE" "$EVENTS_LOG_ABS"; then
    pass "C-7: el reintento quedo anotado en events.log"
else
    fail "C-7: events.log no registra el reintento"
fi

# -------- Resumen --------

echo ""
echo "Resultado: $PASS PASS, $FAIL FAIL"
[ "$FAIL" -eq 0 ]
