#!/usr/bin/env bash
# test-agent-hold.sh -- Tests de la politica de espera (hold) ante
# RATE_LIMIT/PROVIDER_UNAVAILABLE persistente (issue #967).
#
# Contexto: el reintento con backoff del issue #534 ya distinguia un fallo
# transitorio del proveedor, pero con la politica equivocada para una ventana
# de uso agotada o un proveedor caido de verdad -- espera fija y corta
# (MEFISTO_AGENT_RETRY_BACKOFF_SECONDS, default 120s) y presupuesto de
# intentos limitado (MEFISTO_AGENT_MAX_ATTEMPTS, default 3). Este issue agrega
# una SEGUNDA politica al mismo bucle de run_agent (mefisto-tooling-pipeline.sh):
# cuando RATE_LIMIT (nunca retryable con el backoff corto, #965) o
# PROVIDER_UNAVAILABLE (una vez agotado ese backoff corto) siguen fallando, el
# stage no aborta -- se sienta a esperar, con su propio techo
# (MEFISTO_HOLD_MAX_SECONDS) y su propia cadencia de sondeo
# (MEFISTO_HOLD_PROBE_SECONDS), sin tocar ni el watchdog del stage ni el
# presupuesto de reintento de #534.
#
# Casos cubiertos:
#   [pre] las funciones nuevas existen en _mefisto-common.sh
#   [A]   agent_failure_is_holdable: RATE_LIMIT/PROVIDER_UNAVAILABLE
#         califican, el resto no
#   [B]   agent_events_resets_at: lee `resets_at` de la RAIZ del terminal
#         (no de `error`), cadena vacia cuando falta/es null
#   [C]   iso8601_to_epoch: conversion redonda de una fecha conocida
#   [D]   el bucle de run_agent: entra en hold sin abortar (CA-1), sondea cada
#         MEFISTO_HOLD_PROBE_SECONDS cuando no hay resets_at, respeta el techo
#         MEFISTO_HOLD_MAX_SECONDS y aborta fail-loud al agotarlo (CA-2), dos
#         presupuestos independientes de MAX_ATTEMPTS/watchdog (CA-4), NUNCA
#         restaura el worktree (CA-5), deja rastro "[hold]" en events.log
#         (CA-3) y reporta el tiempo esperado al terminar bien (CA-6)
#
# Uso: .claude/scripts/tests/test-agent-hold.sh
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

# extract_fn <function_name> <file> -- mismo patron que test-agent-retry.sh
extract_fn() {
    local name="$1" file="$2"
    awk -v fn="$name" '$0 ~ "^"fn"\\(\\) \\{" {p=1} p{print} p && /^}/{p=0}' "$file"
}

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# -------- Bloque pre --------

echo "[pre] Las funciones nuevas estan definidas en _mefisto-common.sh"
for fn in agent_failure_is_holdable agent_events_resets_at iso8601_to_epoch; do
    if declare -F "$fn" >/dev/null; then
        pass "$fn definida"
    else
        fail "$fn NO definida"
    fi
done

# -------- Bloque A: agent_failure_is_holdable --------

echo ""
echo "[A] agent_failure_is_holdable: solo RATE_LIMIT/PROVIDER_UNAVAILABLE esperan"

for label in "RATE_LIMIT (exit 1)" "PROVIDER_UNAVAILABLE (exit 1)"; do
    if agent_failure_is_holdable "$label"; then
        pass "A-1: '$label' es holdable"
    else
        fail "A-1: '$label' deberia ser holdable"
    fi
done

for label in "TIMEOUT (1800s, exit 137)" "API_ERROR_CLIENT (exit 1)" \
             "STREAM_CUT (exit 1)" "CLI_ERROR (exit 3)" \
             "SIGNAL_MID_FLIGHT (exit 137, 12s)" "SIGNAL_POST_SUCCESS (exit 137, 12s)" ""; do
    if agent_failure_is_holdable "$label"; then
        fail "A-2: '${label:-<vacio>}' NO deberia ser holdable"
    else
        pass "A-2: '${label:-<vacio>}' no espera"
    fi
done

# -------- Bloque B: agent_events_resets_at --------

echo ""
echo "[B] agent_events_resets_at lee la RAIZ del terminal, no error.*"

EVENTS_RATE_LIMIT_WITH_RESET="$TMP/events-rl-reset.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-05-07T22:00:05Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"rate_limit","detail":"ventana agotada"},"resets_at":"2026-05-07T22:40:00Z"}' > "$EVENTS_RATE_LIMIT_WITH_RESET"

EVENTS_RATE_LIMIT_NULL_RESET="$TMP/events-rl-noreset.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-09-06T22:00:05Z","status":"failed","runtime":"opencode","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"rate_limit","detail":"429"},"resets_at":null}' > "$EVENTS_RATE_LIMIT_NULL_RESET"

EVENTS_5XX="$TMP/events-5xx.jsonl"
printf '%s\n' '{"v":1,"type":"run.failed","ts":"2026-08-05T10:00:00Z","status":"failed","runtime":"claude","model":null,"session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"provider_unavailable","detail":"API Error: 529 Overloaded"}}' > "$EVENTS_5XX"

EVENTS_OK="$TMP/events-ok.jsonl"
printf '%s\n' '{"v":1,"type":"run.completed","ts":"2026-08-05T10:00:00Z","status":"success","runtime":"claude","model":"claude-sonnet-5","session_id":null,"duration_ms":100,"tokens":{"input":null,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":null}' > "$EVENTS_OK"

got=$(agent_events_resets_at "$EVENTS_RATE_LIMIT_WITH_RESET")
if [ "$got" = "2026-05-07T22:40:00Z" ]; then
    pass "B-1: resets_at poblado se lee tal cual"
else
    fail "B-1: se esperaba '2026-05-07T22:40:00Z', se obtuvo '$got'"
fi

got=$(agent_events_resets_at "$EVENTS_RATE_LIMIT_NULL_RESET")
if [ -z "$got" ]; then
    pass "B-2: resets_at null da cadena vacia"
else
    fail "B-2: se esperaba cadena vacia, se obtuvo '$got'"
fi

got=$(agent_events_resets_at "$EVENTS_5XX")
if [ -z "$got" ]; then
    pass "B-3: terminal sin campo resets_at (PROVIDER_UNAVAILABLE) da cadena vacia"
else
    fail "B-3: se esperaba cadena vacia, se obtuvo '$got'"
fi

FIXTURES_DIR="$REPO_ROOT/src/runtime/contract/fixtures/run-events"

got=$(agent_events_resets_at "$FIXTURES_DIR/valid-rate-limit-claude.jsonl")
if [ "$got" = "2026-05-07T22:40:00Z" ]; then
    pass "B-4: fixture canonico del contrato (claude) -> resets_at poblado"
else
    fail "B-4: se esperaba '2026-05-07T22:40:00Z' del fixture canonico, se obtuvo '$got'"
fi

got=$(agent_events_resets_at "$FIXTURES_DIR/valid-rate-limit-opencode.jsonl")
if [ -z "$got" ]; then
    pass "B-5: fixture canonico del contrato (opencode) -> resets_at null da cadena vacia"
else
    fail "B-5: se esperaba cadena vacia del fixture canonico, se obtuvo '$got'"
fi

# -------- Bloque C: iso8601_to_epoch --------

echo ""
echo "[C] iso8601_to_epoch convierte ida y vuelta"

epoch=$(iso8601_to_epoch "2026-05-07T22:40:00Z" 2>/dev/null)
if [ -n "$epoch" ]; then
    back=$(date -u -r "$epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)
    if [ "$back" = "2026-05-07T22:40:00Z" ]; then
        pass "C-1: '2026-05-07T22:40:00Z' -> $epoch -> '$back'"
    else
        fail "C-1: la vuelta no coincide (obtuvo '$back')"
    fi
else
    fail "C-1: iso8601_to_epoch no pudo parsear una fecha valida"
fi

if ! iso8601_to_epoch "" >/dev/null 2>&1; then
    pass "C-2: cadena vacia falla (exit != 0)"
else
    fail "C-2: cadena vacia deberia fallar"
fi

# -------- Bloque D: el bucle de run_agent --------

echo ""
echo "[D] run_agent: hold en vez de abortar, con su propio techo y sondeo"

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

    # Reintento corto de #534 fuera de juego a proposito: este archivo prueba
    # el hold, no el backoff de #534 (ya cubierto en test-agent-retry.sh).
    export MEFISTO_AGENT_MAX_ATTEMPTS=1
    export MEFISTO_AGENT_RETRY_BACKOFF_SECONDS=0
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
# Mismo patron que test-agent-retry.sh: falla <failures> veces con
# <events_fail>/<fail_exit>, despues copia <events_success> con exit 0.
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

# D-1/D-3/D-5: RATE_LIMIT sin resets_at, 2 sondeos y exito al tercero.
# HOLD_PROBE_SECONDS=1 mantiene el test rapido; HOLD_MAX_SECONDS de sobra.
WT_D1=$(new_wt)
setup_run_agent_env "$WT_D1"
export MEFISTO_HOLD_MAX_SECONDS=3600
export MEFISTO_HOLD_PROBE_SECONDS=1
make_run_agent_stub "$EVENTS_RATE_LIMIT_NULL_RESET" "$EVENTS_OK" 1 2
eval "$(extract_fn run_agent "$INTERNAL_PIPELINE")"

rc=0
run_agent "1" "writer" "prompt" >/dev/null 2>&1 || rc=$?

if [ "$rc" -eq 0 ]; then
    pass "D-1: el stage termina bien tras esperar (no aborta)"
else
    fail "D-1: el stage deberia terminar bien (rc=$rc)"
fi

got=$(attempts_made)
if [ "$got" = "3" ]; then
    pass "D-3: sondeo cada MEFISTO_HOLD_PROBE_SECONDS -- 3 invocaciones (2 en hold + 1 exito)"
else
    fail "D-3: se esperaban 3 invocaciones, hubo $got"
fi

if grep -q '\[hold\] RATE_LIMIT: esperando, proxima sonda' "$EVENTS_LOG_ABS"; then
    pass "D-5: events.log deja el rastro [hold] con el formato de CA-3"
else
    fail "D-5: events.log no tiene la linea [hold] esperada"
fi

if ! grep -q "REINTENTO" "$EVENTS_LOG_ABS"; then
    pass "D-5b: el hold no se confunde con el reintento corto de #534 (sin lineas REINTENTO)"
else
    fail "D-5b: no deberia haber lineas REINTENTO -- RATE_LIMIT nunca pasa por ahi"
fi

# D-6 (CA-6): el resumen reporta cuanto se espero.
if [ "$LAST_AGENT_HOLD_SECONDS" -ge 2 ]; then
    pass "D-6: LAST_AGENT_HOLD_SECONDS reporta el tiempo en espera ($LAST_AGENT_HOLD_SECONDS s)"
else
    fail "D-6: LAST_AGENT_HOLD_SECONDS deberia ser >= 2, fue '$LAST_AGENT_HOLD_SECONDS'"
fi

# D-7 (CA-5): el worktree NUNCA se restaura durante el hold, aunque entrara
# limpio -- a diferencia del reintento corto de #534 (ver C-5 en
# test-agent-retry.sh). El stub no ensucia el worktree por si mismo, asi que
# se verifica indirectamente: si algo lo hubiera reseteado a ENTRY_COMMIT el
# historial de commits seguiria siendo solo el commit base; en cambio, aqui
# lo que importa es que ningun `reset --hard`/`clean -fd` corrio -- para
# probarlo con evidencia positiva se ensucia el worktree ANTES de la corrida
# (ya limpio al entrar) y se confirma que sobrevive.
WT_D7=$(new_wt)
setup_run_agent_env "$WT_D7"
export MEFISTO_HOLD_MAX_SECONDS=3600
export MEFISTO_HOLD_PROBE_SECONDS=1
: > "$TMP/attempts.txt"
cat > "$TMP/fake-run-agent-d7.sh" <<EOF
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
    echo "trabajo a medias" > "$WT_D7/parcial.txt"
    cp "$EVENTS_RATE_LIMIT_NULL_RESET" "\$event_log"
    exit 1
else
    cp "$EVENTS_OK" "\$event_log"
    exit 0
fi
EOF
chmod +x "$TMP/fake-run-agent-d7.sh"
export MEFISTO_RUN_AGENT_BIN="$TMP/fake-run-agent-d7.sh"
eval "$(extract_fn run_agent "$INTERNAL_PIPELINE")"
run_agent "1" "writer" "prompt" >/dev/null 2>&1 || true

if [ -f "$WT_D7/parcial.txt" ]; then
    pass "D-7: el worktree NO se restaura durante el hold (trabajo parcial sobrevive)"
else
    fail "D-7: el hold no deberia tocar el worktree, pero parcial.txt desaparecio"
fi

# D-2 (CA-4, independiente de MAX_ATTEMPTS): PROVIDER_UNAVAILABLE persistente
# entra en hold apenas agota MAX_ATTEMPTS=1 (fijado en setup_run_agent_env) y
# sigue reintentando -- 4 fallos y exito al 5to, muy por encima del tope de
# reintento corto, sin que MAX_ATTEMPTS lo frene.
WT_D2=$(new_wt)
setup_run_agent_env "$WT_D2"
export MEFISTO_HOLD_MAX_SECONDS=3600
export MEFISTO_HOLD_PROBE_SECONDS=1
make_run_agent_stub "$EVENTS_5XX" "$EVENTS_OK" 1 4
rc=0
run_agent "1" "writer" "prompt" >/dev/null 2>&1 || rc=$?

if [ "$rc" -eq 0 ] && [ "$(attempts_made)" = "5" ]; then
    pass "D-2: PROVIDER_UNAVAILABLE sigue reintentando en hold mas alla de MAX_ATTEMPTS=1 (5 invocaciones)"
else
    fail "D-2: se esperaba exito en 5 invocaciones (rc=$rc, attempts=$(attempts_made))"
fi

# D-2b (CA-1, resets_at tiene precedencia sobre el sondeo): con resets_at en
# el PASADO (fixture de 2026-05-07) el margen de 60s sobre esa fecha da un
# hold_sleep negativo, que la funcion clampea a 1s -- sin exponer el margen
# como variable, este es el camino rapido para ejercer la rama resets_at sin
# dormir minutos reales. HOLD_PROBE_SECONDS se deja deliberadamente alto
# (999s): si resets_at NO tuviera precedencia, este caso tardaria minutos.
WT_D2B=$(new_wt)
setup_run_agent_env "$WT_D2B"
export MEFISTO_HOLD_MAX_SECONDS=3600
export MEFISTO_HOLD_PROBE_SECONDS=999
make_run_agent_stub "$EVENTS_RATE_LIMIT_WITH_RESET" "$EVENTS_OK" 1 2

start_epoch=$(date +%s)
rc=0
run_agent "1" "writer" "prompt" >/dev/null 2>&1 || rc=$?
wall=$(( $(date +%s) - start_epoch ))

if [ "$rc" -eq 0 ] && [ "$wall" -lt 30 ]; then
    pass "D-2b: resets_at en el pasado clampea la espera en vez de usar los 999s del sondeo (${wall}s)"
else
    fail "D-2b: se esperaba exito rapido (rc=$rc, ${wall}s) -- resets_at no esta acortando la espera"
fi

# D-4 (CA-2): techo agotado aborta fail-loud, nombrando la espera y la senal.
# El stub del abort() de setup_run_agent_env solo `return`-ea (no hace exit
# real como el abort() de produccion), asi que run_agent sigue ejecutando
# lineas despues -- todas exitosas -- y su propio rc no es una senal fiable
# de aborto en este arnes (el mismo motivo por el que test-agent-retry.sh
# tampoco lo chequea en sus casos "fail"). La evidencia de que abort() SI se
# invoco, y con que mensaje, es $TMP/aborted.txt.
WT_D4=$(new_wt)
setup_run_agent_env "$WT_D4"
export MEFISTO_HOLD_MAX_SECONDS=1
export MEFISTO_HOLD_PROBE_SECONDS=1
make_run_agent_stub "$EVENTS_RATE_LIMIT_NULL_RESET" "$EVENTS_OK" 1 99
: > "$TMP/aborted.txt"
run_agent "1" "writer" "prompt" >/dev/null 2>&1 || true

if [ -s "$TMP/aborted.txt" ] \
    && grep -q "techo de espera agotado" "$TMP/aborted.txt" \
    && grep -q "RATE_LIMIT" "$TMP/aborted.txt"; then
    pass "D-4: el techo agotado aborta fail-loud, nombrando la espera y la ultima senal"
else
    fail "D-4: el mensaje de aborto no trae la info esperada: $(cat "$TMP/aborted.txt" 2>/dev/null)"
fi

# D-4b (CA-4): el techo de hold es independiente del watchdog del stage -- el
# watchdog vive DENTRO de mefisto-run-agent.sh (el `--timeout` que se le pasa
# a cada invocacion), nunca en este bucle; la espera entre invocaciones es un
# `sleep` liso que ese watchdog jamas ve. D-1 ya lo demuestra por rc=0 pese a
# dormir varios segundos reales; aqui se confirma ademas que un aborto por
# techo de hold agotado (D-4) nunca se etiqueta como TIMEOUT en events.log --
# son causas distintas y no deben confundirse en el rastro.
if ! grep -q "TIMEOUT" "$EVENTS_LOG_ABS"; then
    pass "D-4b: el hold nunca dispara el watchdog del stage (sin TIMEOUT en events.log)"
else
    fail "D-4b: events.log no deberia mencionar TIMEOUT durante un hold"
fi

# D-8 (CA-2): el techo se mide en RELOJ desde que arranco la espera, no
# sumando solo los `sleep`. Con MEFISTO_HOLD_PROBE_SECONDS=0 la suma de
# siestas es 0 para siempre: si el techo se midiera asi, el bucle no
# terminaria nunca aunque cada sonda queme segundos reales (el caso de un
# PROVIDER_UNAVAILABLE que tarda minutos en morir). El stub gasta 1s por
# intento y cede al 20mo como valvula de seguridad -- una regresion a la
# contabilidad por siestas se delata gastando esos 20 intentos.
WT_D8=$(new_wt)
setup_run_agent_env "$WT_D8"
export MEFISTO_HOLD_MAX_SECONDS=2
export MEFISTO_HOLD_PROBE_SECONDS=0
: > "$TMP/attempts.txt"
cat > "$TMP/fake-run-agent-d8.sh" <<EOF
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
sleep 1
if [ "\$n" -le "20" ]; then
    cp "$EVENTS_RATE_LIMIT_NULL_RESET" "\$event_log"
    exit 1
else
    cp "$EVENTS_OK" "\$event_log"
    exit 0
fi
EOF
chmod +x "$TMP/fake-run-agent-d8.sh"
export MEFISTO_RUN_AGENT_BIN="$TMP/fake-run-agent-d8.sh"
run_agent "1" "writer" "prompt" >/dev/null 2>&1 || true

got=$(attempts_made)
if [ "$got" -le 6 ]; then
    pass "D-8: el techo se agota por reloj aunque las siestas sumen 0 ($got invocaciones)"
else
    fail "D-8: el techo no se esta midiendo en reloj -- $got invocaciones (se esperaban <= 6)"
fi

# -------- Resumen --------

echo ""
echo "Resultado: $PASS PASS, $FAIL FAIL"
[ "$FAIL" -eq 0 ]
