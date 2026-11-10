#!/usr/bin/env bash
# test-mefisto-run-agent.sh -- Tests del protocolo neutral de ejecucion y
# eventos (MEF-ADR-0049 CA-1/CA-2, issue #858).
#
# Cubre:
#   [pre] Los archivos nuevos existen, tienen sintaxis valida y el schema es
#         JSON valido.
#   [A] CA-1: validacion de argumentos de mefisto-run-agent.sh -- faltantes y
#       archivos inexistentes abortan con exit 64; --timeout no entero (o 0)
#       tambien.
#   [B] CA-2: mefisto_resolve_runtime (lib/mefisto-runtime.sh) resuelve segun
#       la precedencia explicito > MEFISTO_RUNTIME > autodeteccion, con PATH
#       y MEFISTO_RUNTIME_LIB_DIR controlados (nunca el PATH real de la
#       maquina: ni el "cero instalados" ni el "dos instalados" dependen de
#       lo que esta maquina tenga instalado de verdad; el segundo runtime es
#       un id inventado, `otro`, con su adaptador stub).
#   [C] CA-3/CA-4: cada fixture de fixtures/run-events/valid-*.jsonl valida
#       linea a linea contra su definitions[.type]; cada fixture de
#       invalid-*.jsonl tiene al menos una linea que NO valida (o, en el caso
#       de dos terminales, un conteo de eventos terminales != 1 -- invariante
#       que el schema por-linea no puede expresar). Incluye la particion del
#       vocabulario de `status` entre los dos terminales (`run.completed` solo
#       admite `success`).
#   [D] CA-5/CA-6: runtime-fake.sh recorre cada guion de MEFISTO_FAKE_SCRIPT
#       invocando el runner real (mefisto-run-agent.sh --runtime fake) y
#       verifica exit code, que TODAS las lineas de --event-log validen
#       contra el schema, y que el conteo de eventos terminales sea
#       EXACTAMENTE 1 -- incluso en los guiones donde el adaptador fake emite
#       cero o dos (el runner los normaliza, CA-5).
#   [E] Ida y vuelta de --model: recibido vs. omitido llega igual a
#       run.started.model y al terminal.model (CA-1: vacio/ausente no llega
#       al adaptador).
#   [H] CA-1..CA-4 (issue #924): con runtime-fake.sh slow-success y
#       MEFISTO_RUN_AGENT_LIVE_INTERVAL=1, --event-log ya trae 'message' y
#       'tool.started' (sin terminal) ANTES de que el runner termine; al
#       cierre hay exactamente un run.completed{status:"success"}, sin
#       tool.started/tool.completed duplicados, todas las lineas validan, y
#       la secuencia final (type/tool/text/status) es IDENTICA a la del
#       guion success, que por terminar antes del primer tick nunca pasa por
#       el anexo en vivo -- la paridad "igual que hoy" de CA-2. Cierra con la
#       degradacion de CA-1: un MEFISTO_RUN_AGENT_LIVE_INTERVAL invalido
#       avisa por stderr, cae al default y no altera el desenlace.
#   [I] CA-1 (issue #968): --resume-session llega tal cual al build_cmd del
#       adaptador activo (visible en el argv que captura
#       MEFISTO_FAKE_ARGS_FILE) y, omitido, NO agrega ningun flag de
#       reanudacion al argv -- la paridad "byte a byte igual a antes de
#       #968" que exige CA-1.
#   [J] CA-1..CA-6 (issue #1128): el modo redactado cubre stream final y vivo,
#       exito/fallo/timeout/protocolo invalido, ambos logs observables, warning
#       de raw/stderr, compatibilidad sin flag y limpieza de temporales.
#   [K] CA-3 (issue #1447): un adaptador de prueba que fija
#       MEFISTO_RUNTIME_STDIN_FILE a una ruta inexistente hace que el runner
#       aborte con exit 69, un mensaje que nombra la variable, y SIN lanzar
#       el proceso del adaptador (se verifica con un marcador que solo se
#       crearia si el comando llegara a ejecutarse).
#   [M] CA-1/CA-2/CA-3/CA-5 (issue #2472): con el guion success-then-hang, la
#       gracia MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S corta al proceso que ya
#       declaro exito (exit 0, POST-RESULT en --events-log); con gracia mayor
#       que --timeout gana el timeout pero se conserva el exito; sin exito
#       sigue siendo timeout 124; gracia invalida cae al default 120.
#   [G] El runner resuelve sus propias libs por su UBICACION, no por el cwd
#       del caller: invocado desde un cwd fuera de todo repo git sigue
#       corriendo (regresion de la resolucion via `git rev-parse`).
#   [F] Ningun test de este archivo invoca `claude` (grep sobre si mismo) --
#       todo corre contra el adaptador fake.
#
# Uso: .claude/scripts/tests/test-mefisto-run-agent.sh
# Exit code: 0 si todos los checks pasan, 1 si alguno falla.
# Bash 3.2 + jq 1.7 (MEF-ADR-0049 CA-6): sin arrays asociativos.

set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
INTERNAL_SCRIPTS="$REPO_ROOT/src/internal/scripts"
RUNTIME_DIR="$REPO_ROOT/src/runtime"
LIB_DIR="$RUNTIME_DIR/lib"
CONTRACT_DIR="$REPO_ROOT/src/runtime/contract"
RUNNER="$RUNTIME_DIR/mefisto-run-agent.sh"
RUNTIME_LIB="$LIB_DIR/mefisto-runtime.sh"
FAKE_LIB="$LIB_DIR/runtime-fake.sh"
SCHEMA_FILE="$CONTRACT_DIR/run-events.schema.json"
JSONSCHEMA_LITE="$INTERNAL_SCRIPTS/lib/jsonschema-lite.jq"
FIXTURES_DIR="$CONTRACT_DIR/fixtures/run-events"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

WORKDIR="$TMP/wt"
mkdir -p "$WORKDIR"
PROMPT_FILE="$TMP/prompt.txt"
echo "prompt de prueba" > "$PROMPT_FILE"
SYSTEM_FILE="$TMP/system.txt"
echo "system de prueba" > "$SYSTEM_FILE"

# validate_event_line <json-line> -- imprime motivos de rechazo (o nada);
# retorna 0 si la linea valida contra definitions[.type], 1 si no (incluido
# ".type" fuera del vocabulario cerrado -- que no tiene entrada en
# definitions).
validate_event_line() {
    local line="$1"
    local ev_type
    ev_type="$(printf '%s' "$line" | jq -r '.type // empty' 2>/dev/null)"
    if [ -z "$ev_type" ]; then
        echo "linea sin campo 'type' (o JSON invalido)"
        return 1
    fi
    local known
    known="$(jq --arg t "$ev_type" '(.types | index($t)) != null' "$SCHEMA_FILE" 2>/dev/null)"
    if [ "$known" != "true" ]; then
        echo "type '$ev_type' no esta en el vocabulario cerrado de 'types'"
        return 1
    fi
    local sub_schema errors
    sub_schema="$(jq -c --arg t "$ev_type" '.definitions[$t]' "$SCHEMA_FILE" 2>/dev/null)"
    errors="$(jq -n --argjson schema "$sub_schema" --argjson instance "$line" -f "$JSONSCHEMA_LITE" 2>&1)"
    if [ -n "$errors" ] && [ "$(printf '%s' "$errors" | jq 'length' 2>/dev/null)" != "0" ]; then
        printf '%s' "$errors" | jq -r '.[]'
        return 1
    fi
    case "$ev_type" in
        run.completed|run.failed)
            if ! printf '%s' "$line" | jq -e 'has("estimated_cost_usd") or has("cost_usd")' >/dev/null 2>&1; then
                echo "terminal sin estimated_cost_usd ni cost_usd"
                return 1
            fi
            ;;
    esac
    return 0
}

# count_terminals <archivo-jsonl>
count_terminals() {
    jq -c 'select(.type == "run.completed" or .type == "run.failed")' "$1" 2>/dev/null | wc -l | tr -d ' '
}

echo "[pre] Archivos nuevos existen, sintaxis valida y schema JSON valido"

for f in "$RUNNER" "$RUNTIME_LIB" "$FAKE_LIB"; do
    if [ -f "$f" ]; then
        pass "existe: ${f#"$REPO_ROOT"/}"
    else
        fail "no existe: ${f#"$REPO_ROOT"/}"
    fi
done

if [ -x "$RUNNER" ]; then
    pass "mefisto-run-agent.sh es ejecutable"
else
    fail "mefisto-run-agent.sh no es ejecutable"
fi

for f in "$RUNNER" "$RUNTIME_LIB" "$FAKE_LIB"; do
    if bash -n "$f" 2>/dev/null; then
        pass "sintaxis bash valida: ${f#"$REPO_ROOT"/}"
    else
        fail "sintaxis bash invalida: ${f#"$REPO_ROOT"/}"
    fi
done

if jq empty "$SCHEMA_FILE" 2>/dev/null; then
    pass "run-events.schema.json es JSON valido"
else
    fail "run-events.schema.json NO es JSON valido"
fi

# shellcheck source=/dev/null
source "$RUNTIME_LIB" 2>/dev/null
if declare -F mefisto_resolve_runtime >/dev/null 2>&1; then
    pass "mefisto_resolve_runtime definida"
else
    fail "mefisto_resolve_runtime NO definida"
fi

# shellcheck source=/dev/null
source "$FAKE_LIB" 2>/dev/null
for fn in runtime_fake_build_cmd runtime_fake_translate; do
    if declare -F "$fn" >/dev/null 2>&1; then
        pass "$fn definida"
    else
        fail "$fn NO definida"
    fi
done

# ============================================================================
echo ""
echo "[A] CA-1: validacion de argumentos (exit 64 ante faltantes/invalidos)"

check_usage_exit64() {
    local desc="$1"; shift
    local out rc
    out=$("$RUNNER" "$@" 2>&1)
    rc=$?
    if [ "$rc" -eq 64 ]; then
        pass "$desc -> exit 64"
    else
        fail "$desc -> exit $rc (esperaba 64). Salida: $out"
    fi
}

check_usage_exit64 "sin --agent" \
    --cwd "$WORKDIR" --prompt-file "$PROMPT_FILE" --event-log "$TMP/ev-a1.jsonl"
check_usage_exit64 "sin --cwd" \
    --agent a --prompt-file "$PROMPT_FILE" --event-log "$TMP/ev-a2.jsonl"
check_usage_exit64 "sin --prompt-file" \
    --agent a --cwd "$WORKDIR" --event-log "$TMP/ev-a3.jsonl"
check_usage_exit64 "sin --event-log" \
    --agent a --cwd "$WORKDIR" --prompt-file "$PROMPT_FILE"
check_usage_exit64 "--cwd inexistente" \
    --agent a --cwd "$TMP/no-existe" --prompt-file "$PROMPT_FILE" --event-log "$TMP/ev-a4.jsonl"
check_usage_exit64 "--prompt-file inexistente" \
    --agent a --cwd "$WORKDIR" --prompt-file "$TMP/no-existe.txt" --event-log "$TMP/ev-a5.jsonl"
check_usage_exit64 "--system-file inexistente" \
    --agent a --cwd "$WORKDIR" --prompt-file "$PROMPT_FILE" --event-log "$TMP/ev-a6.jsonl" --system-file "$TMP/no-existe.txt"
check_usage_exit64 "--timeout no entero" \
    --agent a --cwd "$WORKDIR" --prompt-file "$PROMPT_FILE" --event-log "$TMP/ev-a7.jsonl" --timeout abc
check_usage_exit64 "--timeout 0" \
    --agent a --cwd "$WORKDIR" --prompt-file "$PROMPT_FILE" --event-log "$TMP/ev-a8.jsonl" --timeout 0
check_usage_exit64 "argumento desconocido" \
    --agent a --cwd "$WORKDIR" --prompt-file "$PROMPT_FILE" --event-log "$TMP/ev-a9.jsonl" --bogus-flag x

HELP_OUT="$($RUNNER --help 2>&1)"
if [ "$?" -eq 0 ] && printf '%s' "$HELP_OUT" | grep -q -- '--redact-observability'; then
    pass "--help documenta --redact-observability y termina con exit 0"
else
    fail "--help no documento --redact-observability o termino con exit no cero"
fi

# ============================================================================
echo ""
echo "[B] CA-2: mefisto_resolve_runtime -- precedencia y deteccion, sin depender del PATH real"

BIN_NONE="$TMP/bin-none"; mkdir -p "$BIN_NONE"
BIN_CLAUDE="$TMP/bin-claude"; mkdir -p "$BIN_CLAUDE"
printf '#!/bin/sh\nexit 0\n' > "$BIN_CLAUDE/claude"; chmod +x "$BIN_CLAUDE/claude"
BIN_BOTH="$TMP/bin-both"; mkdir -p "$BIN_BOTH"
cp "$BIN_CLAUDE/claude" "$BIN_BOTH/claude"
printf '#!/bin/sh\nexit 0\n' > "$BIN_BOTH/otro"; chmod +x "$BIN_BOTH/otro"
LIBDIR_STUB="$TMP/libdir-stub"; mkdir -p "$LIBDIR_STUB"
printf '%s\n' 'runtime_claude_is_available() { command -v claude >/dev/null 2>&1; }' > "$LIBDIR_STUB/runtime-claude.sh"
printf '%s\n' 'runtime_otro_is_available() { command -v otro >/dev/null 2>&1; }' > "$LIBDIR_STUB/runtime-otro.sh"

ORIG_PATH="$PATH"
unset MEFISTO_RUNTIME

PATH="$BIN_NONE"; MEFISTO_RUNTIME_LIB_DIR="$LIBDIR_STUB"
if ! mefisto_resolve_runtime "" >/dev/null 2>&1; then
    case "$MEFISTO_RUNTIME_ERROR" in
        *MEFISTO_RUNTIME*) pass "B-1: cero runtimes instalados -> falla y el motivo nombra MEFISTO_RUNTIME" ;;
        *) fail "B-1: el motivo no nombra MEFISTO_RUNTIME: $MEFISTO_RUNTIME_ERROR" ;;
    esac
else
    fail "B-1: deberia fallar con PATH sin ningun runtime"
fi
PATH="$ORIG_PATH"

PATH="$BIN_BOTH"; MEFISTO_RUNTIME_LIB_DIR="$LIBDIR_STUB"
if ! mefisto_resolve_runtime "" >/dev/null 2>&1; then
    case "$MEFISTO_RUNTIME_ERROR" in
        *MEFISTO_RUNTIME*) pass "B-2: dos runtimes instalados -> falla y el motivo nombra MEFISTO_RUNTIME" ;;
        *) fail "B-2: el motivo no nombra MEFISTO_RUNTIME: $MEFISTO_RUNTIME_ERROR" ;;
    esac
else
    fail "B-2: deberia fallar con PATH con claude y otro a la vez"
fi
PATH="$ORIG_PATH"

PATH="$BIN_CLAUDE"; MEFISTO_RUNTIME_LIB_DIR="$LIBDIR_STUB"
RESOLVED="$(mefisto_resolve_runtime "" 2>/dev/null)"
if [ "$RESOLVED" = "claude" ]; then
    pass "B-3: exactamente claude instalado -> autodeteccion resuelve 'claude'"
else
    fail "B-3: se esperaba 'claude', se obtuvo '$RESOLVED'"
fi
PATH="$ORIG_PATH"

PATH="$BIN_NONE"; MEFISTO_RUNTIME_LIB_DIR="$LIBDIR_STUB"
RESOLVED="$(mefisto_resolve_runtime "otro" 2>/dev/null)"
if [ "$RESOLVED" = "otro" ]; then
    pass "B-4: --runtime explicito gana aunque el PATH no tenga ningun runtime instalado"
else
    fail "B-4: se esperaba 'otro' (explicito), se obtuvo '$RESOLVED'"
fi
PATH="$ORIG_PATH"

PATH="$BIN_NONE"; MEFISTO_RUNTIME_LIB_DIR="$LIBDIR_STUB"; MEFISTO_RUNTIME="otro"
RESOLVED="$(mefisto_resolve_runtime "" 2>/dev/null)"
if [ "$RESOLVED" = "otro" ]; then
    pass "B-5: MEFISTO_RUNTIME (entorno) gana sobre la autodeteccion"
else
    fail "B-5: se esperaba 'otro' (via MEFISTO_RUNTIME), se obtuvo '$RESOLVED'"
fi
unset MEFISTO_RUNTIME
PATH="$ORIG_PATH"

PATH="$BIN_NONE"; MEFISTO_RUNTIME_LIB_DIR="$LIBDIR_STUB"
if ! mefisto_resolve_runtime "bogus" >/dev/null 2>&1; then
    pass "B-6: runtime explicito sin libreria de adaptador -> falla"
else
    fail "B-6: deberia fallar sin libreria runtime-bogus.sh"
fi
PATH="$ORIG_PATH"

PATH="$BIN_NONE"; MEFISTO_RUNTIME_LIB_DIR="$LIB_DIR"
RESOLVED="$(mefisto_resolve_runtime "fake" 2>/dev/null)"
if [ "$RESOLVED" = "fake" ]; then
    pass "B-7: --runtime fake resuelve contra la libreria real del repo"
else
    fail "B-7: se esperaba 'fake' contra el LIB_DIR real, se obtuvo '$RESOLVED'"
fi
PATH="$ORIG_PATH"

# ============================================================================
echo ""
echo "[C] CA-3/CA-4: fixtures de run-events validan (o no) contra su definitions[.type]"

check_all_lines_valid() {
    local name="$1" file="$2"
    local bad=0 line reason
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        if ! reason="$(validate_event_line "$line")"; then
            bad=1
        fi
    done < "$file"
    if [ "$bad" -eq 0 ]; then
        pass "$name: todas las lineas validan"
    else
        fail "$name: alguna linea no valido: $reason"
    fi
}

check_all_lines_valid "valid-success.jsonl" "$FIXTURES_DIR/valid-success.jsonl"
check_all_lines_valid "valid-failed.jsonl" "$FIXTURES_DIR/valid-failed.jsonl"
check_all_lines_valid "valid-timeout.jsonl" "$FIXTURES_DIR/valid-timeout.jsonl"
# issue #965: terminal de un agotamiento de ventana de uso, con y sin resets_at.
check_all_lines_valid "valid-rate-limit-claude.jsonl" "$FIXTURES_DIR/valid-rate-limit-claude.jsonl"
check_all_lines_valid "valid-rate-limit-sin-reset.jsonl" "$FIXTURES_DIR/valid-rate-limit-sin-reset.jsonl"
check_all_lines_valid "legacy-cost-usd.jsonl" "$FIXTURES_DIR/legacy-cost-usd.jsonl"

if jq -e 'select(.type=="run.failed") | .error.kind == "rate_limit" and .resets_at == "2026-05-07T22:40:00Z"' "$FIXTURES_DIR/valid-rate-limit-claude.jsonl" >/dev/null 2>&1; then
    pass "valid-rate-limit-claude.jsonl: error.kind='rate_limit' con resets_at poblado"
else
    fail "valid-rate-limit-claude.jsonl: no trae el error.kind/resets_at esperado"
fi
if jq -e 'select(.type=="run.failed") | .error.kind == "rate_limit" and .resets_at == null' "$FIXTURES_DIR/valid-rate-limit-sin-reset.jsonl" >/dev/null 2>&1; then
    pass "valid-rate-limit-sin-reset.jsonl: error.kind='rate_limit' con resets_at null"
else
    fail "valid-rate-limit-sin-reset.jsonl: no trae el error.kind/resets_at esperado"
fi

TERMS=$(count_terminals "$FIXTURES_DIR/invalid-two-terminals.jsonl")
if [ "$TERMS" = "2" ]; then
    pass "invalid-two-terminals.jsonl: el fixture SI trae 2 terminales (invariante cross-linea que el schema por-linea no puede rechazar)"
else
    fail "invalid-two-terminals.jsonl: se esperaban 2 terminales en el fixture, se contaron $TERMS"
fi

BAD_LINE="$(sed -n '2p' "$FIXTURES_DIR/invalid-missing-field.jsonl")"
if ! validate_event_line "$BAD_LINE" >/dev/null 2>&1; then
    pass "invalid-missing-field.jsonl: la linea sin 'tokens' se rechaza"
else
    fail "invalid-missing-field.jsonl: deberia rechazarse por falta de 'tokens'"
fi

BAD_LINE="$(sed -n '2p' "$FIXTURES_DIR/invalid-unknown-type.jsonl")"
if ! validate_event_line "$BAD_LINE" >/dev/null 2>&1; then
    pass "invalid-unknown-type.jsonl: 'bogus.event' fuera del vocabulario se rechaza"
else
    fail "invalid-unknown-type.jsonl: deberia rechazarse por 'type' desconocido"
fi

# El vocabulario de status esta partido entre los dos terminales: un
# run.completed solo puede declararse 'success'. Sin esta particion, un gate
# que decidiera por .type y otro que decidiera por .status podrian puntuar la
# misma corrida distinto -- justo lo que MEF-ADR-0031 no admite.
BAD_LINE="$(sed -n '2p' "$FIXTURES_DIR/invalid-status-mismatch.jsonl")"
if ! validate_event_line "$BAD_LINE" >/dev/null 2>&1; then
    pass "invalid-status-mismatch.jsonl: run.completed{status:'timeout'} se rechaza"
else
    fail "invalid-status-mismatch.jsonl: deberia rechazarse (status 'timeout' solo es de run.failed)"
fi

GOOD_LINE="$(sed -n '3p' "$FIXTURES_DIR/valid-failed.jsonl")"
if validate_event_line "$GOOD_LINE" >/dev/null 2>&1; then
    pass "valid-failed.jsonl: run.failed{status:'failed'} sigue validando tras partir el vocabulario"
else
    fail "valid-failed.jsonl: la particion de status rompio un terminal legitimo"
fi

LEGACY_LINE="$(sed -n '2p' "$FIXTURES_DIR/legacy-cost-usd.jsonl")"
if validate_event_line "$LEGACY_LINE" >/dev/null 2>&1 \
    && printf '%s' "$LEGACY_LINE" | jq -e 'has("cost_usd") and (has("estimated_cost_usd") | not)' >/dev/null 2>&1; then
    pass "legacy-cost-usd.jsonl: cost_usd v1 sigue siendo legible sin reinterpretarse"
else
    fail "legacy-cost-usd.jsonl: el lector del contrato rechazo el terminal v1"
fi

BAD_LINE="$(sed -n '2p' "$FIXTURES_DIR/invalid-missing-cost-name.jsonl")"
if ! validate_event_line "$BAD_LINE" >/dev/null 2>&1; then
    pass "invalid-missing-cost-name.jsonl: el gate exige estimated_cost_usd o cost_usd"
else
    fail "invalid-missing-cost-name.jsonl: el gate acepto un terminal sin ningun nombre de costo"
fi

BAD_FAILED_LINE="$(printf '%s' "$BAD_LINE" | jq -c '.type="run.failed" | .status="failed" | .error={kind:"nonzero_exit",detail:"fallo"}')"
if ! validate_event_line "$BAD_FAILED_LINE" >/dev/null 2>&1; then
    pass "gate de run.failed: tambien exige estimated_cost_usd o cost_usd"
else
    fail "gate de run.failed: acepto un terminal sin ningun nombre de costo"
fi

if grep -l '"cost_usd"' "$FIXTURES_DIR"/*.jsonl | grep -qv '/legacy-cost-usd.jsonl$'; then
    fail "fixtures del contrato: solo el fixture legacy puede contener cost_usd"
else
    pass "fixtures del contrato: los nuevos usan estimated_cost_usd y el nombre legacy esta aislado"
fi

# ============================================================================
echo ""
echo "[D] CA-5/CA-6: runner real contra cada guion de runtime-fake.sh"

run_fake_scenario() {
    # run_fake_scenario <event_log> [args del runner...]
    local ev="$1"; shift
    "$RUNNER" --runtime fake --agent test-agent --cwd "$WORKDIR" \
        --prompt-file "$PROMPT_FILE" --event-log "$ev" "$@" >/dev/null 2>&1
    echo $?
}

check_scenario() {
    local desc="$1" ev="$2" expected_exit="$3" expected_status="$4" expected_error_kind="$5" rc="$6"

    if [ "$rc" = "$expected_exit" ]; then
        pass "$desc: exit $rc"
    else
        fail "$desc: exit $rc (esperaba $expected_exit)"
    fi

    if [ ! -s "$ev" ]; then
        fail "$desc: --event-log vacio o inexistente"
        return
    fi

    local bad=0 line reason
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        if ! reason="$(validate_event_line "$line")"; then
            bad=1
            echo "    linea invalida: $reason"
        fi
    done < "$ev"
    if [ "$bad" -eq 0 ]; then
        pass "$desc: todas las lineas de --event-log validan contra el schema"
    else
        fail "$desc: alguna linea de --event-log no valido (ver arriba)"
    fi

    local terms
    terms=$(count_terminals "$ev")
    if [ "$terms" = "1" ]; then
        pass "$desc: exactamente 1 evento terminal en --event-log"
    else
        fail "$desc: se contaron $terms eventos terminales (se esperaba 1)"
    fi

    if jq -e 'select(.type=="run.completed" or .type=="run.failed")
        | has("estimated_cost_usd") and (has("cost_usd") | not)
          and (.tokens | has("input") and has("output") and has("cache_read") and has("cache_write") and has("reasoning"))' "$ev" >/dev/null 2>&1; then
        pass "$desc: fake/sintetico usa solo el contrato nuevo de costo y tokens"
    else
        fail "$desc: fake/sintetico emitio forma legacy o incompleta"
    fi

    local last_status last_kind
    last_status="$(jq -r 'select(.type=="run.completed" or .type=="run.failed") | .status' "$ev" 2>/dev/null | tail -n1)"
    if [ "$last_status" = "$expected_status" ]; then
        pass "$desc: status='$last_status'"
    else
        fail "$desc: status='$last_status' (esperaba '$expected_status')"
    fi

    if [ -n "$expected_error_kind" ]; then
        last_kind="$(jq -r 'select(.type=="run.completed" or .type=="run.failed") | .error.kind // empty' "$ev" 2>/dev/null | tail -n1)"
        if [ "$last_kind" = "$expected_error_kind" ]; then
            pass "$desc: error.kind='$last_kind'"
        else
            fail "$desc: error.kind='$last_kind' (esperaba '$expected_error_kind')"
        fi
    fi
}

EV="$TMP/d-success.jsonl"
RC=$(MEFISTO_FAKE_SCRIPT=success run_fake_scenario "$EV")
check_scenario "success" "$EV" 0 "success" "" "$RC"

EV="$TMP/d-fail.jsonl"
RC=$(MEFISTO_FAKE_SCRIPT=fail MEFISTO_FAKE_EXIT_CODE=7 run_fake_scenario "$EV")
check_scenario "fail (exit 7)" "$EV" 7 "failed" "nonzero_exit" "$RC"

EV="$TMP/d-hang.jsonl"
RC=$(MEFISTO_FAKE_SCRIPT=hang run_fake_scenario "$EV" --timeout 1)
check_scenario "hang (timeout)" "$EV" 124 "timeout" "timeout" "$RC"
DURATION_MS="$(jq -r 'select(.type=="run.failed") | .duration_ms' "$EV" 2>/dev/null | tail -n1)"
if [ -n "$DURATION_MS" ] && [ "$DURATION_MS" -ge 1000 ]; then
    pass "hang (timeout): duration_ms ($DURATION_MS) refleja el tiempo real transcurrido, no un cero fabricado"
else
    fail "hang (timeout): duration_ms='$DURATION_MS' (se esperaba >= 1000)"
fi
# El terminal sintetizado reemplaza al del adaptador, pero los eventos NO
# terminales son hechos ya ocurridos: son la unica pista de DONDE se colgo la
# corrida, y descartarlos dejaria el --event-log de un timeout sin evidencia.
if jq -e 'select(.type=="message")' "$EV" >/dev/null 2>&1; then
    pass "hang (timeout): el mensaje emitido antes del cuelgue sobrevive en --event-log"
else
    fail "hang (timeout): se perdieron los eventos no terminales previos al timeout"
fi

EV="$TMP/d-no-terminal.jsonl"
RC=$(MEFISTO_FAKE_SCRIPT=no-terminal run_fake_scenario "$EV")
check_scenario "no-terminal (protocol_invalid)" "$EV" 65 "protocol_invalid" "protocol_invalid" "$RC"

EV="$TMP/d-two-terminals.jsonl"
RC=$(MEFISTO_FAKE_SCRIPT=two-terminals run_fake_scenario "$EV")
check_scenario "two-terminals (protocol_invalid)" "$EV" 65 "protocol_invalid" "protocol_invalid" "$RC"

EV="$TMP/d-malformed.jsonl"
RC=$(MEFISTO_FAKE_SCRIPT=malformed run_fake_scenario "$EV")
check_scenario "malformed (protocol_invalid)" "$EV" 65 "protocol_invalid" "protocol_invalid" "$RC"
if jq -e 'select(.type=="message")' "$EV" >/dev/null 2>&1; then
    pass "malformed: el mensaje emitido ANTES del corte sobrevive en --event-log"
else
    fail "malformed: se perdio el mensaje valido emitido antes de la linea rota"
fi

# ============================================================================
echo ""
echo "[K] CA-3 (issue #1447): MEFISTO_RUNTIME_STDIN_FILE invalida aborta sin lanzar el proceso"

BADSTDIN_LIBDIR="$TMP/libdir-badstdin"; mkdir -p "$BADSTDIN_LIBDIR"
BADSTDIN_MARKER="$TMP/k-badstdin-ran"
BADSTDIN_BOGUS_PATH="$TMP/does-not-exist/mefisto-stdin-1447"
rm -f "$BADSTDIN_MARKER"

# El adaptador de prueba deja MEFISTO_RUNTIME_STDIN_FILE apuntando a una ruta
# que nunca existe, y su argv (si llegara a correr) dejaria un marcador en
# disco -- la unica forma de comprobar desde afuera que run_agent_with_watchdog
# NUNCA se invoco.
{
    echo 'runtime_badstdin_is_available() { return 0; }'
    printf 'runtime_badstdin_build_cmd() {\n'
    printf '    MEFISTO_RUNTIME_CMD=(bash -c "touch %q")\n' "$BADSTDIN_MARKER"
    printf '    MEFISTO_RUNTIME_STDIN_FILE=%q\n' "$BADSTDIN_BOGUS_PATH"
    printf '}\n'
    echo 'runtime_badstdin_translate() { :; }'
} > "$BADSTDIN_LIBDIR/runtime-badstdin.sh"

K_EV="$TMP/k-badstdin.jsonl"
K_ERR="$TMP/k-badstdin.err"
MEFISTO_RUNTIME_LIB_DIR="$BADSTDIN_LIBDIR" "$RUNNER" --runtime badstdin --agent test-agent --cwd "$WORKDIR" \
    --prompt-file "$PROMPT_FILE" --event-log "$K_EV" >/dev/null 2>"$K_ERR"
K_RC=$?

if [ "$K_RC" = "69" ]; then
    pass "K-1: MEFISTO_RUNTIME_STDIN_FILE apuntando a una ruta inexistente -> exit 69"
else
    fail "K-1: exit $K_RC (esperaba 69). stderr: $(cat "$K_ERR" 2>/dev/null)"
fi

if grep -q "MEFISTO_RUNTIME_STDIN_FILE" "$K_ERR" 2>/dev/null; then
    pass "K-2: el mensaje de error nombra MEFISTO_RUNTIME_STDIN_FILE explicitamente"
else
    fail "K-2: el mensaje de error no menciona MEFISTO_RUNTIME_STDIN_FILE: $(cat "$K_ERR" 2>/dev/null)"
fi

if [ ! -f "$BADSTDIN_MARKER" ]; then
    pass "K-3: el proceso del adaptador NUNCA se lanzo (el marcador no se creo)"
else
    fail "K-3: el proceso se lanzo pese a la validacion fallida de MEFISTO_RUNTIME_STDIN_FILE"
fi

# ============================================================================
echo ""
echo "[J] CA-1..CA-6 (issue #1128): persistencia redactada"

redaction_has_no_sentinels() {
    local file="$1"
    ! grep -Eq 'PROMPT_SENTINEL|ASSISTANT_SENTINEL|COMMAND_SENTINEL|STDERR_SENTINEL|HEADER_SENTINEL|AUTH_TOKEN_SENTINEL' "$file"
}

J_SUCCESS="$TMP/j-sensitive-success.jsonl"
J_RC=$(MEFISTO_FAKE_SCRIPT=sensitive-success run_fake_scenario "$J_SUCCESS" --redact-observability --model runtime-model-allowed)
if [ "$J_RC" = "0" ] && redaction_has_no_sentinels "$J_SUCCESS" \
    && ! jq -e 'select(.type == "message")' "$J_SUCCESS" >/dev/null 2>&1 \
    && jq -e 'select(.type == "tool.started") | .input_summary == null' "$J_SUCCESS" >/dev/null 2>&1 \
    && jq -e 'select(.type == "run.completed") | .runtime == "fake" and .model == "runtime-model-allowed"' "$J_SUCCESS" >/dev/null 2>&1; then
    pass "L-1: exito redactado omite mensajes/inputs y conserva runtime/modelo/terminal sin centinelas"
else
    fail "L-1: el exito redactado filtro mal contenidos o cambio el desenlace"
fi
check_scenario "J-1 exito redactado" "$J_SUCCESS" 0 "success" "" "$J_RC"
J_FIRST_TYPE="$(jq -r '.type' "$J_SUCCESS" 2>/dev/null | sed -n '1p')"
J_LAST_TYPE="$(jq -r '.type' "$J_SUCCESS" 2>/dev/null | tail -n1)"
J_STARTED_COUNT="$(jq -c 'select(.type == "run.started")' "$J_SUCCESS" 2>/dev/null | wc -l | tr -d ' ')"
if [ "$J_FIRST_TYPE" = "run.started" ] && [ "$J_LAST_TYPE" = "run.completed" ] && [ "$J_STARTED_COUNT" = "1" ]; then
    pass "J-1a: stream redactado inicia una vez y termina en su unico terminal"
else
    fail "J-1a: orden/cardinalidad invalido (first=$J_FIRST_TYPE last=$J_LAST_TYPE started=$J_STARTED_COUNT)"
fi

J_BASELINE="$TMP/j-sensitive-baseline.jsonl"
J_BASELINE_RC=$(MEFISTO_FAKE_SCRIPT=sensitive-success run_fake_scenario "$J_BASELINE" --model runtime-model-allowed)
if [ "$J_BASELINE_RC" = "0" ] && ! redaction_has_no_sentinels "$J_BASELINE" \
    && jq -e 'select(.type == "message")' "$J_BASELINE" >/dev/null 2>&1 \
    && jq -e 'select(.type == "tool.started") | .input_summary == "COMMAND_SENTINEL input"' "$J_BASELINE" >/dev/null 2>&1; then
    pass "J-1b: sin flag conserva mensajes, input_summary y desenlace legacy"
else
    fail "J-1b: el modo omitido dejo de ser compatible con la persistencia vigente"
fi

J_FAIL="$TMP/j-sensitive-fail.jsonl"
MEFISTO_FAKE_SCRIPT=sensitive-fail MEFISTO_FAKE_EXIT_CODE=7 "$RUNNER" --runtime fake --agent test-agent --cwd "$WORKDIR" \
    --prompt-file "$PROMPT_FILE" --event-log "$J_FAIL" --redact-observability >/dev/null 2>&1
J_FAIL_RC=$?
if [ "$J_FAIL_RC" = "7" ] && redaction_has_no_sentinels "$J_FAIL" \
    && jq -e 'select(.type == "run.failed") | .status == "failed" and .error.kind == "api_error" and .error.detail == "detalle redactado: api_error"' "$J_FAIL" >/dev/null 2>&1; then
    pass "L-2: fallo redactado conserva status/kind/exit y sustituye detail"
else
    fail "L-2: el fallo redactado filtro mal detail o cambio el desenlace"
fi
check_scenario "J-2 fallo redactado" "$J_FAIL" 7 "failed" "api_error" "$J_FAIL_RC"
J_FAIL_BASE="$TMP/j-sensitive-fail-baseline.jsonl"
MEFISTO_FAKE_SCRIPT=sensitive-fail MEFISTO_FAKE_EXIT_CODE=7 "$RUNNER" --runtime fake --agent test-agent --cwd "$WORKDIR" \
    --prompt-file "$PROMPT_FILE" --event-log "$J_FAIL_BASE" >/dev/null 2>&1
J_FAIL_BASE_RC=$?
J_FAIL_SHAPE="$(jq -c 'select(.type == "run.failed") | [.type, .status, .error.kind]' "$J_FAIL")"
J_FAIL_BASE_SHAPE="$(jq -c 'select(.type == "run.failed") | [.type, .status, .error.kind]' "$J_FAIL_BASE")"
if [ "$J_FAIL_RC" = "$J_FAIL_BASE_RC" ] && [ "$J_FAIL_SHAPE" = "$J_FAIL_BASE_SHAPE" ]; then
    pass "J-2b: redaccion conserva type/status/error.kind/exit frente al modo vigente"
else
    fail "J-2b: redaccion cambio el desenlace respecto del modo vigente"
fi

for J_SCRIPT in hang no-terminal malformed; do
    J_EV="$TMP/j-${J_SCRIPT}.jsonl"
    if [ "$J_SCRIPT" = hang ]; then
        J_RC=$(MEFISTO_FAKE_SCRIPT="$J_SCRIPT" run_fake_scenario "$J_EV" --redact-observability --timeout 1)
    else
        J_RC=$(MEFISTO_FAKE_SCRIPT="$J_SCRIPT" run_fake_scenario "$J_EV" --redact-observability)
    fi
    case "$J_SCRIPT" in
        hang) J_EXIT=124; J_STATUS=timeout; J_KIND=timeout ;;
        *) J_EXIT=65; J_STATUS=protocol_invalid; J_KIND=protocol_invalid ;;
    esac
    check_scenario "J-3 $J_SCRIPT redactado" "$J_EV" "$J_EXIT" "$J_STATUS" "$J_KIND" "$J_RC"
    if ! jq -e 'select(.type == "message")' "$J_EV" >/dev/null 2>&1 \
        && jq -e 'select(.type == "run.failed") | .error.detail == ("detalle redactado: " + .error.kind)' "$J_EV" >/dev/null 2>&1; then
        pass "J-3 $J_SCRIPT redactado: no convierte un desenlace anomalo en exito"
    else
        fail "J-3 $J_SCRIPT redactado: persistio message o detail no redactado"
    fi
done

J_LIVE="$TMP/j-live.jsonl"
J_LIVE_RC="$TMP/j-live.rc"
(
    MEFISTO_FAKE_SCRIPT=slow-success MEFISTO_FAKE_STEP_DELAY_S=2 MEFISTO_RUN_AGENT_LIVE_INTERVAL=1 \
        "$RUNNER" --runtime fake --agent test-agent --cwd "$WORKDIR" --prompt-file "$PROMPT_FILE" \
        --event-log "$J_LIVE" --redact-observability >/dev/null 2>&1
    echo $? > "$J_LIVE_RC"
) &
J_LIVE_PID=$!
J_LIVE_SEEN=false
J_LIVE_WAIT=0
while [ "$J_LIVE_WAIT" -lt 24 ]; do
    if [ -s "$J_LIVE" ] && ! jq -e 'select(.type == "message")' "$J_LIVE" >/dev/null 2>&1 \
        && jq -e 'select(.type == "tool.started") | .input_summary == null' "$J_LIVE" >/dev/null 2>&1; then
        J_LIVE_SEEN=true
        break
    fi
    kill -0 "$J_LIVE_PID" 2>/dev/null || break
    sleep 0.25
    J_LIVE_WAIT=$((J_LIVE_WAIT + 1))
done
if [ "$J_LIVE_SEEN" = true ]; then
    pass "L-4: el anexo en vivo usa el mismo filtro redactado"
else
    fail "L-4: el anexo en vivo expuso mensaje o input_summary"
fi
wait "$J_LIVE_PID" 2>/dev/null
check_scenario "J-4 vivo redactado" "$J_LIVE" 0 "success" "" "$(cat "$J_LIVE_RC")"

J_RAW="$TMP/j-raw.log"; J_STDERR="$TMP/j-stderr.log"; J_WARNING="$TMP/j-warning.err"
MEFISTO_FAKE_SCRIPT=sensitive-fail "$RUNNER" --runtime fake --agent test-agent --cwd "$WORKDIR" \
    --prompt-file "$PROMPT_FILE" --event-log "$TMP/j-warning.jsonl" --redact-observability \
    --raw-log "$J_RAW" --stderr-log "$J_STDERR" >/dev/null 2>"$J_WARNING"
if grep -Fq -- "$J_RAW" "$J_WARNING" && grep -Fq -- "$J_STDERR" "$J_WARNING" \
    && grep -Fq -- 'no son observabilidad segura' "$J_WARNING" \
    && grep -Fq 'AUTH_TOKEN_SENTINEL' "$J_RAW" && grep -Fq 'AUTH_TOKEN_SENTINEL' "$J_STDERR"; then
    pass "J-5: raw/stderr quedan intactos y reciben advertencia con destinos explicitos"
else
    fail "J-5: falta evidencia de raw/stderr intactos o su advertencia explicita"
fi

J_EVENTS="$TMP/j-events.log"
MEFISTO_FAKE_SCRIPT=sensitive-success "$RUNNER" --runtime fake --agent test-agent --cwd "$WORKDIR" \
    --prompt-file "$PROMPT_FILE" --event-log "$TMP/j-events.jsonl" --events-log "$J_EVENTS" \
    --redact-observability >/dev/null 2>&1
if [ -s "$J_EVENTS" ] && redaction_has_no_sentinels "$J_EVENTS" \
    && grep -q '\[tool\] test-agent Bash ok -' "$J_EVENTS"; then
    pass "J-6: --events-log se deriva de la misma proyeccion redactada"
else
    fail "J-6: --events-log filtro un input sensible o perdio la cardinalidad de tools"
fi

J_PRIVATE_PARENT="$TMP/j-private"
mkdir -p "$J_PRIVATE_PARENT"
TMPDIR="$J_PRIVATE_PARENT/" MEFISTO_FAKE_SCRIPT=sensitive-success run_fake_scenario \
    "$TMP/j-private.jsonl" --redact-observability >/dev/null
if [ -z "$(ls -A "$J_PRIVATE_PARENT" 2>/dev/null)" ]; then
    pass "J-7: raw/stderr temporales se eliminaron al salir"
else
    fail "J-7: quedaron archivos del temporal privado tras salir"
fi

# ============================================================================
echo ""
echo "[E] Ida y vuelta de --model: recibido vs. omitido (CA-1)"

EV="$TMP/e-model-received.jsonl"
RC=$(MEFISTO_FAKE_SCRIPT=success run_fake_scenario "$EV" --model demo-model-xyz)
STARTED_MODEL="$(jq -r 'select(.type=="run.started") | .model' "$EV" 2>/dev/null)"
TERMINAL_MODEL="$(jq -r 'select(.type=="run.completed" or .type=="run.failed") | .model' "$EV" 2>/dev/null)"
if [ "$STARTED_MODEL" = "demo-model-xyz" ] && [ "$TERMINAL_MODEL" = "demo-model-xyz" ]; then
    pass "E-1: --model demo-model-xyz llega a run.started.model y al terminal.model (via build_cmd -> CLI fake -> translate)"
else
    fail "E-1: run.started.model='$STARTED_MODEL' terminal.model='$TERMINAL_MODEL' (esperaba 'demo-model-xyz' en ambos)"
fi

EV="$TMP/e-model-omitted.jsonl"
RC=$(MEFISTO_FAKE_SCRIPT=success run_fake_scenario "$EV")
STARTED_MODEL="$(jq -c 'select(.type=="run.started") | .model' "$EV" 2>/dev/null)"
TERMINAL_MODEL="$(jq -c 'select(.type=="run.completed" or .type=="run.failed") | .model' "$EV" 2>/dev/null)"
if [ "$STARTED_MODEL" = "null" ] && [ "$TERMINAL_MODEL" = "null" ]; then
    pass "E-2: sin --model, run.started.model y terminal.model son null (nunca llego al adaptador)"
else
    fail "E-2: run.started.model='$STARTED_MODEL' terminal.model='$TERMINAL_MODEL' (esperaba null en ambos)"
fi

# ============================================================================
echo ""
echo "[H] CA-1..CA-4 (issue #924): anexo en vivo de eventos no terminales"

EV="$TMP/h-slow-success.jsonl"
RC_FILE="$TMP/h-rc"
(
    MEFISTO_FAKE_SCRIPT=slow-success MEFISTO_FAKE_STEP_DELAY_S=2 MEFISTO_RUN_AGENT_LIVE_INTERVAL=1 \
        "$RUNNER" --runtime fake --agent test-agent --cwd "$WORKDIR" \
        --prompt-file "$PROMPT_FILE" --event-log "$EV" --timeout 60 >/dev/null 2>&1
    echo $? > "$RC_FILE"
) &
H_PID=$!

# El guion slow-success tarda ~6s (3 sleeps de MEFISTO_FAKE_STEP_DELAY_S=2) y
# el intervalo en vivo es 1s: hay margen de sobra para observar el archivo a
# mitad de vuelo, con message y tool.started ya anexados y sin terminal
# todavia.
H_SEEN_LIVE=false
i=0
while [ "$i" -lt 40 ]; do
    if [ -s "$EV" ] \
        && jq -e 'select(.type=="message")' "$EV" >/dev/null 2>&1 \
        && jq -e 'select(.type=="tool.started")' "$EV" >/dev/null 2>&1 \
        && ! jq -e 'select(.type=="run.completed" or .type=="run.failed")' "$EV" >/dev/null 2>&1; then
        H_SEEN_LIVE=true
        break
    fi
    kill -0 "$H_PID" 2>/dev/null || break
    sleep 0.25
    i=$((i + 1))
done

if [ "$H_SEEN_LIVE" = "true" ]; then
    pass "H-1: --event-log ya trae 'message' y 'tool.started' (sin terminal) ANTES de que el runner termine"
else
    fail "H-1: no se observo el anexo en vivo antes de que el runner terminara"
fi

wait "$H_PID" 2>/dev/null
H_RC="$(cat "$RC_FILE" 2>/dev/null || echo "?")"

if [ "$H_RC" = "0" ]; then
    pass "H-2: el runner termina con exit 0"
else
    fail "H-2: exit '$H_RC' (esperaba 0)"
fi

H_TERMS=$(count_terminals "$EV")
if [ "$H_TERMS" = "1" ]; then
    pass "H-3: exactamente 1 evento terminal en --event-log al terminar"
else
    fail "H-3: se contaron $H_TERMS eventos terminales (se esperaba 1)"
fi

H_STATUS="$(jq -r 'select(.type=="run.completed") | .status' "$EV" 2>/dev/null | tail -n1)"
if [ "$H_STATUS" = "success" ]; then
    pass "H-4: run.completed{status:'success'} sin duplicados"
else
    fail "H-4: status='$H_STATUS' (esperaba 'success')"
fi

H_STARTED_COUNT=$(jq -c 'select(.type=="tool.started")' "$EV" 2>/dev/null | wc -l | tr -d ' ')
H_COMPLETED_COUNT=$(jq -c 'select(.type=="tool.completed")' "$EV" 2>/dev/null | wc -l | tr -d ' ')
if [ "$H_STARTED_COUNT" = "1" ] && [ "$H_COMPLETED_COUNT" = "1" ]; then
    pass "H-5: exactamente 1 tool.started y 1 tool.completed (el anexo en vivo no duplico nada al cierre)"
else
    fail "H-5: tool.started=$H_STARTED_COUNT tool.completed=$H_COMPLETED_COUNT (se esperaba 1 y 1)"
fi

H_ALL_VALID=true
while IFS= read -r line; do
    [ -n "$line" ] || continue
    validate_event_line "$line" >/dev/null 2>&1 || H_ALL_VALID=false
done < "$EV"
if [ "$H_ALL_VALID" = "true" ]; then
    pass "H-6: todas las lineas de --event-log (anexadas en vivo o al cierre) validan contra el schema"
else
    fail "H-6: alguna linea de --event-log no valido contra el schema"
fi

# CA-2 ("la misma secuencia de eventos que hoy"): el guion success termina muy
# por debajo del primer intervalo, asi que su --event-log nunca pasa por el
# anexo en vivo -- es exactamente el "hoy" contra el que hay que comparar. La
# proyeccion descarta ts y duration_ms (varian entre corridas por
# construccion: runtime_fake_translate pone `ts: now` y el runner mide el
# duration_ms real) y conserva lo que el CA nombra.
h_event_shape() { jq -c '[.type, (.tool // ""), (.text // ""), (.status // "")]' "$1" 2>/dev/null; }

H_BASELINE="$TMP/h-success-baseline.jsonl"
MEFISTO_FAKE_SCRIPT=success "$RUNNER" --runtime fake --agent test-agent --cwd "$WORKDIR" \
    --prompt-file "$PROMPT_FILE" --event-log "$H_BASELINE" >/dev/null 2>&1
if [ -s "$H_BASELINE" ] && [ "$(h_event_shape "$H_BASELINE")" = "$(h_event_shape "$EV")" ]; then
    pass "H-7: la secuencia final con anexo en vivo es identica a la del guion success sin anexo (CA-2)"
else
    fail "H-7: la secuencia final difiere de la del guion success (sin anexo en vivo)"
fi

# CA-1: un intervalo invalido no es una condicion de arranque -- avisa, cae al
# default y la corrida termina igual. "00" es el caso que un chequeo puramente
# lexico de digitos dejaria pasar como valido siendo cero.
for H_BAD in "abc" "0" "00" "-1"; do
    H_BAD_EV="$TMP/h-bad-interval.jsonl"
    H_BAD_ERR="$TMP/h-bad-interval.err"
    MEFISTO_RUN_AGENT_LIVE_INTERVAL="$H_BAD" MEFISTO_FAKE_SCRIPT=success \
        "$RUNNER" --runtime fake --agent test-agent --cwd "$WORKDIR" \
        --prompt-file "$PROMPT_FILE" --event-log "$H_BAD_EV" >/dev/null 2>"$H_BAD_ERR"
    H_BAD_RC=$?
    if [ "$H_BAD_RC" = "0" ] \
        && grep -q "MEFISTO_RUN_AGENT_LIVE_INTERVAL" "$H_BAD_ERR" \
        && [ "$(count_terminals "$H_BAD_EV")" = "1" ]; then
        pass "H-8: MEFISTO_RUN_AGENT_LIVE_INTERVAL='$H_BAD' avisa por stderr, cae al default y no altera el desenlace (exit 0, 1 terminal)"
    else
        fail "H-8: MEFISTO_RUN_AGENT_LIVE_INTERVAL='$H_BAD' -> exit $H_BAD_RC, terminales=$(count_terminals "$H_BAD_EV"), aviso=$(grep -c MEFISTO_RUN_AGENT_LIVE_INTERVAL "$H_BAD_ERR")"
    fi
done
# ============================================================================
echo ""
echo "[I] CA-1 (issue #968): --resume-session se reenvia al adaptador activo"

EV="$TMP/i-resume-received.jsonl"
ARGS_FILE="$TMP/i-resume-received.args"
RC=$(MEFISTO_FAKE_ARGS_FILE="$ARGS_FILE" MEFISTO_FAKE_SCRIPT=success run_fake_scenario "$EV" --resume-session "sess-resume-1")
if [ "$RC" = "0" ]; then
    pass "I-1: --resume-session no rompe una corrida exitosa (exit 0)"
else
    fail "I-1: exit inesperado con --resume-session presente: $RC"
fi
if [ -f "$ARGS_FILE" ] && grep -A1 -xF -- "--fake-resume" "$ARGS_FILE" | tail -n1 | grep -qxF "sess-resume-1"; then
    pass "I-2: --resume-session llego al build_cmd del adaptador activo (--fake-resume sess-resume-1 en el argv capturado)"
else
    fail "I-2: el adaptador no recibio el resume_session_id: $(cat "$ARGS_FILE" 2>/dev/null)"
fi

EV="$TMP/i-resume-omitted.jsonl"
ARGS_FILE="$TMP/i-resume-omitted.args"
RC=$(MEFISTO_FAKE_ARGS_FILE="$ARGS_FILE" MEFISTO_FAKE_SCRIPT=success run_fake_scenario "$EV")
if [ -f "$ARGS_FILE" ] && ! grep -qxF -- "--fake-resume" "$ARGS_FILE"; then
    pass "I-3: sin --resume-session, ningun --fake-resume llega al adaptador (byte a byte igual a antes de #968, CA-1)"
else
    fail "I-3: --fake-resume aparecio sin que --resume-session se pasara: $(cat "$ARGS_FILE" 2>/dev/null)"
fi

echo ""
echo "[L] CA-3/CA-5 (issue #2496): --effort se reenvia al adaptador y queda en run.started"

EV="$TMP/j-effort.jsonl"
ARGS_FILE="$TMP/j-effort.args"
L_RAW="$TMP/l-effort.raw"
RC=$(MEFISTO_FAKE_ARGS_FILE="$ARGS_FILE" MEFISTO_FAKE_SCRIPT=success run_fake_scenario "$EV" --effort "high" --raw-log "$L_RAW")
if [ "$RC" = "0" ] && grep -A1 -xF -- "--fake-effort" "$ARGS_FILE" | tail -n1 | grep -qxF "high"; then
    pass "L-1: --effort high llega al adaptador (--fake-effort high en el argv capturado)"
else
    fail "L-1: --effort no llego al adaptador (exit $RC): $(cat "$ARGS_FILE" 2>/dev/null)"
fi
if [ "$(head -n1 "$EV" | jq -c '.effort')" = '"high"' ] \
    && [ "$(grep -F '"fake":"terminal"' "$L_RAW" 2>/dev/null | jq -c '.effort')" = '"high"' ]; then
    pass "L-2: run.started trae effort high y el CLI fake lo registra en su terminal"
else
    fail "L-2: effort high ausente de run.started/terminal: $(cat "$EV" "$L_RAW" 2>/dev/null)"
fi

for _eff_case in omitido vacio; do
    EV="$TMP/j-effort-$_eff_case.jsonl"
    ARGS_FILE="$TMP/j-effort-$_eff_case.args"
    if [ "$_eff_case" = "omitido" ]; then
        RC=$(MEFISTO_FAKE_ARGS_FILE="$ARGS_FILE" MEFISTO_FAKE_SCRIPT=success run_fake_scenario "$EV")
    else
        RC=$(MEFISTO_FAKE_ARGS_FILE="$ARGS_FILE" MEFISTO_FAKE_SCRIPT=success run_fake_scenario "$EV" --effort "")
    fi
    if [ "$RC" = "0" ] && ! grep -qxF -- "--fake-effort" "$ARGS_FILE" && [ "$(head -n1 "$EV" | jq -c '.effort')" = "null" ]; then
        pass "L-3 ($_eff_case): sin effort no llega nada al adaptador y run.started trae effort null"
    else
        fail "L-3 ($_eff_case): comportamiento inesperado sin effort (exit $RC): $(cat "$ARGS_FILE" 2>/dev/null)"
    fi
done

EV="$TMP/j-effort-noval.jsonl"
RC=$(MEFISTO_FAKE_SCRIPT=success run_fake_scenario "$EV" --effort 2>/dev/null)
if [ "$RC" = "64" ]; then
    pass "L-4: --effort sin valor aborta con exit 64 (mismo error de uso que --model sin valor)"
else
    fail "L-4: --effort sin valor devolvio exit $RC (se esperaba 64)"
fi


echo ""
echo "[M] CA-1/CA-2/CA-3/CA-5 (issue #2472): corte tras exito declarado y gracia"

# run_post_result <tag> <script> <grace|__unset__> <timeout> -- deja
# $TMP/m-<tag>.{jsonl,events,stderr}, y fija M_RC y M_ELAPSED.
run_post_result() {
    local tag="$1" script="$2" grace="$3" tmo="$4" t0 t1
    rm -f "$TMP/m-$tag.events"
    t0=$(date +%s)
    if [ "$grace" = "__unset__" ]; then
        MEFISTO_FAKE_SCRIPT="$script" MEFISTO_RUN_AGENT_LIVE_INTERVAL=1 MEFISTO_WATCHDOG_POLL_S=1 \
            "$RUNNER" --runtime fake --agent test-agent --cwd "$WORKDIR" --prompt-file "$PROMPT_FILE" \
            --event-log "$TMP/m-$tag.jsonl" --events-log "$TMP/m-$tag.events" --timeout "$tmo" >/dev/null 2>"$TMP/m-$tag.stderr"
    else
        MEFISTO_FAKE_SCRIPT="$script" MEFISTO_RUN_AGENT_LIVE_INTERVAL=1 MEFISTO_WATCHDOG_POLL_S=1 \
            MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S="$grace" \
            "$RUNNER" --runtime fake --agent test-agent --cwd "$WORKDIR" --prompt-file "$PROMPT_FILE" \
            --event-log "$TMP/m-$tag.jsonl" --events-log "$TMP/m-$tag.events" --timeout "$tmo" >/dev/null 2>"$TMP/m-$tag.stderr"
    fi
    M_RC=$?
    t1=$(date +%s)
    M_ELAPSED=$((t1 - t0))
}

last_terminal_field() { jq -r --arg f "$2" 'select(.type == "run.completed" or .type == "run.failed") | .[$f]' "$1" 2>/dev/null | tail -n1; }

# CA-1: exito declarado + proceso vivo + gracia corta -> corte antes del timeout.
run_post_result m1 success-then-hang 1 40
if [ "$M_RC" = "0" ] && [ "$M_ELAPSED" -lt 30 ]; then
    pass "M-1: corte por gracia antes del --timeout, exit 0 (${M_ELAPSED}s de 40s)"
else
    fail "M-1: exit $M_RC en ${M_ELAPSED}s (esperaba 0 antes de 30s)"
fi
if [ "$(count_terminals "$TMP/m-m1.jsonl")" = "1" ] \
    && [ "$(tail -n1 "$TMP/m-m1.jsonl" | jq -r '.type + ":" + .status')" = "run.completed:success" ]; then
    pass "M-2: --event-log cierra con exactamente un run.completed{status:success}"
else
    fail "M-2: terminal inesperado: $(tail -n1 "$TMP/m-m1.jsonl" 2>/dev/null)"
fi
if grep -q 'POST-RESULT: test-agent seguia vivo [0-9]*s despues de declarar exito -- SIGTERM' "$TMP/m-m1.events" 2>/dev/null; then
    pass "M-3: --events-log registra la linea POST-RESULT"
else
    fail "M-3: falta POST-RESULT en --events-log: $(cat "$TMP/m-m1.events" 2>/dev/null)"
fi

# CA-2: gracia mayor que el timeout -> el watchdog mata, pero se respeta el exito.
run_post_result m2 success-then-hang 60 3
if [ "$M_RC" = "0" ] && [ "$(tail -n1 "$TMP/m-m2.jsonl" | jq -r '.type + ":" + .status')" = "run.completed:success" ]; then
    pass "M-4: timeout tras exito declarado -> exit 0 con el terminal de exito"
else
    fail "M-4: exit $M_RC, terminal: $(tail -n1 "$TMP/m-m2.jsonl" 2>/dev/null)"
fi
if grep -q 'TIMEOUT tras exito declarado: test-agent' "$TMP/m-m2.events" 2>/dev/null \
    && ! grep -q 'POST-RESULT:' "$TMP/m-m2.events" 2>/dev/null; then
    pass "M-5: --events-log registra 'TIMEOUT tras exito declarado' y no POST-RESULT"
else
    fail "M-5: --events-log inesperado: $(cat "$TMP/m-m2.events" 2>/dev/null)"
fi

# CA-3: sin exito declarado el timeout sigue siendo timeout; y un agente que
# declara exito y sale solo no recibe senal.
run_post_result m3 hang 1 3
if [ "$M_RC" = "124" ] && [ "$(last_terminal_field "$TMP/m-m3.jsonl" status)" = "timeout" ] \
    && ! grep -q 'POST-RESULT:\|TIMEOUT tras exito' "$TMP/m-m3.events" 2>/dev/null; then
    pass "M-6: un guion colgado sin exito termina en run.failed{timeout} con exit 124"
else
    fail "M-6: exit $M_RC, terminal: $(tail -n1 "$TMP/m-m3.jsonl" 2>/dev/null), events: $(cat "$TMP/m-m3.events" 2>/dev/null)"
fi
run_post_result m4 success 1 30
if [ "$M_RC" = "0" ] && ! grep -q 'POST-RESULT:\|TIMEOUT tras exito' "$TMP/m-m4.events" 2>/dev/null; then
    pass "M-7: exito que sale solo no recibe senal ni linea POST-RESULT"
else
    fail "M-7: exit $M_RC, events: $(cat "$TMP/m-m4.events" 2>/dev/null)"
fi

# CA-5: gracia invalida (vacia, 0, no numerica) cae al default 120: con
# --timeout 3 el corte por gracia no llega y gana el timeout tras exito.
for _g in "" 0 abc; do
    _tag="m5-${_g:-vacio}"
    run_post_result "$_tag" success-then-hang "$_g" 3
    if [ "$M_RC" = "0" ] && grep -q 'TIMEOUT tras exito declarado' "$TMP/m-$_tag.events" 2>/dev/null \
        && ! grep -q 'POST-RESULT:' "$TMP/m-$_tag.events" 2>/dev/null; then
        pass "M-8 (gracia '${_g}'): cae al default 120 (sin corte por gracia dentro de 3s)"
    else
        fail "M-8 (gracia '${_g}'): exit $M_RC, events: $(cat "$TMP/m-$_tag.events" 2>/dev/null)"
    fi
done
if grep -q 'MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S' "$TMP/m-m5-abc.stderr" 2>/dev/null; then
    pass "M-9: una gracia invalida avisa por stderr"
else
    fail "M-9: no hubo aviso por stderr para la gracia invalida"
fi

for _doc in "$RUNNER" "$CONTRACT_DIR/README.md"; do
    if grep -q 'MEFISTO_RUN_AGENT_POST_RESULT_GRACE_S' "$_doc" && grep -q 'POST-RESULT' "$_doc"; then
        pass "M-10: ${_doc#"$REPO_ROOT"/} documenta la gracia y el corte"
    else
        fail "M-10: ${_doc#"$REPO_ROOT"/} no documenta la gracia y el corte"
    fi
done

echo ""
echo "[G] El runner no depende del cwd del caller para encontrar sus propias libs"

# El caller natural de este runner es un pipeline parado dentro de un worktree
# ajeno al checkout donde vive el plugin. Resolver la raiz con `git rev-parse
# --show-toplevel` respondia por el cwd DEL CALLER: desde un cwd que no es un
# repo git el runner moria con exit 69 antes de arrancar. Se ejercita con un
# cwd deliberadamente fuera de cualquier repo (el propio $TMP de este test).
G_OUT="$TMP/g-outside.jsonl"
G_RC=$( cd "$TMP" && MEFISTO_FAKE_SCRIPT=success "$RUNNER" --runtime fake --agent test-agent \
        --cwd "$WORKDIR" --prompt-file "$PROMPT_FILE" --event-log "$G_OUT" >/dev/null 2>&1; echo $? )
if [ "$G_RC" = "0" ] && [ -s "$G_OUT" ]; then
    pass "G-1: invocado desde un cwd fuera de todo repo git, el runner corre igual (exit 0)"
else
    fail "G-1: exit $G_RC desde un cwd fuera del repo (se esperaba 0 con --event-log poblado)"
fi

echo ""
echo "[F] Ningun test de este archivo invoca el claude real"

# El archivo SI menciona 'claude' de forma legitima (nombres de archivo stub
# del bloque B, mensajes de error): lo que este check rechaza es el patron de
# invocacion real del CLI (mismo idiom que mefisto-tooling-pipeline.sh:463, el
# modo "print" de Claude Code seguido del flag de modelo/agente), no la
# palabra suelta. La variable FORBIDDEN_CLAUDE_FLAG evita que el propio patron
# de busqueda -- si se citara literal en este comentario o en el mensaje de
# fail -- se autodetecte como un falso positivo.
THIS_FILE="$SCRIPT_DIR/test-mefisto-run-agent.sh"
FORBIDDEN_CLAUDE_FLAG="-p"
if grep -qE "claude[[:space:]]+${FORBIDDEN_CLAUDE_FLAG}" "$THIS_FILE"; then
    fail "F-1: el archivo de test parece invocar el CLI real del runtime (patron de invocacion directa)"
else
    pass "F-1: no se detecto ningun patron de invocacion real del runtime en este test"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
