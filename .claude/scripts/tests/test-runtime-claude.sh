#!/usr/bin/env bash
# test-runtime-claude.sh -- Tests del adaptador de runtime Claude Code
# (MEF-ADR-0049, issue #859): src/runtime/lib/runtime-claude.sh + su traductor.
#
# Ninguno de estos tests invoca el CLI real de Claude Code -- todo corre
# contra una CLI `claude` FALSA (stub bash) puesta primero en el PATH, que
# reproduce fixtures de .claude/scripts/tests/fixtures/runtime-claude/*.jsonl
# y devuelve el exit code que le indique el escenario (mismo espiritu que
# runtime-fake.sh de #858, pero aqui la CLI falsa tiene que ser un binario
# real llamado `claude`: runtime_claude_build_cmd invoca literalmente ese
# nombre).
#
# rate-limit-exhausted.jsonl (issue #965) es una reproduccion VERBATIM de la
# secuencia real que reporta anthropics/claude-code#57096 (CLI v2.1.132):
# `resetsAt: 1778193600` y el "resets 6:40pm (America/New_York)" del mensaje
# sintetico son el par capturado ahi, no valores de adorno -- no "corregirlos"
# para que la fecha del reset se parezca a la del resto del fixture, porque
# entonces el fixture deja de ser evidencia de nada.
#
# Casos cubiertos:
#   [pre] Los archivos nuevos existen, tienen sintaxis valida y el programa
#         jq corre sin errores.
#   [A] CA-1: runtime_claude_build_cmd compone el argv completo SIN prompt
#       posicional -- flags fijos siempre presentes incluido --agent, --model
#       solo si se recibe valor no vacio, --append-system-prompt-file (la
#       RUTA de --system-file, nunca su contenido) solo si se recibe uno, y
#       MEFISTO_RUNTIME_STDIN_FILE queda fijada a --prompt-file tal cual
#       (ningun centinela del prompt ni del system-file aparece en el argv;
#       backticks/`$()`/comillas del prompt viajan intactos solo por stdin).
#   [G] CA-3/CA-4 (issue #1448): paridad ante ARG_MAX -- un prompt >=
#       `getconf ARG_MAX` + 65536 bytes corre por stdin (nunca por argv) via
#       el runner real contra la CLI falsa, con exit 0, exactamente un
#       run.completed y el volcado de stdin identico byte a byte (cmp) al
#       fixture; el stub deja constancia de que stdin no era TTY.
#   [B] CA-2: runtime_claude_translate mapea assistant/text -> message,
#       tool_use -> tool.started, tool_result -> tool.completed (con el
#       nombre de tool resuelto por emparejamiento de id), en el orden del
#       stream.
#   [C] CA-3: la clasificacion completa, en el orden de
#       classify_agent_failure: killed (exit 137/143) > rate_limit
#       (`rate_limit_event{status:"rejected"}`, issue #965) > api_error/
#       provider_unavailable (del evento `result` o del stderr, 5xx ->
#       provider_unavailable antes que 4xx -> api_error) > stream_cut >
#       no_result > nonzero_exit; mas el criterio de exito de tres
#       condiciones (is_error==false + subtype==success +
#       stop_reason==end_turn), que gana sobre cualquier exit code (PR #446)
#       dejando la muerte posterior documentada en `error` sin degradar el
#       `status`.
#   [D] CA-4: el terminal preserva session_id/tokens/estimated_cost_usd/turns/
#       ttft_ms/denials/api_duration_ms cuando Claude los entrega: ausentes
#       -> null, nunca 0 (success-minimal.jsonl).
#   [E] CA-5: --raw-log conserva la traza cruda intacta (mismo contenido que
#       el fixture, sin traducir).
#   [F] CA-6: runner real (mefisto-run-agent.sh --runtime claude) contra la
#       CLI falsa: exito, is_error 529/404, "API Error: 500" solo por stderr,
#       stream truncado, timeout (stub que duerme), exit 137, modelo heredado
#       (sin --model en la linea de comando capturada) y modelo opaco con
#       "[1m]" reenviado literal. Cada
#       caso valida el JSONL contra run-events.schema.json y exactamente un
#       evento terminal.
#
# Uso: .claude/scripts/tests/test-runtime-claude.sh
# Exit code: 0 si todos los checks pasan, 1 si alguno falla.
# Bash 3.2 + jq 1.7 (MEF-ADR-0049 CA-6): sin arrays asociativos.

set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
INTERNAL_SCRIPTS="$REPO_ROOT/src/internal/scripts"
LIB_DIR="$REPO_ROOT/src/runtime/lib"
CONTRACT_DIR="$REPO_ROOT/src/runtime/contract"
RUNNER="$REPO_ROOT/src/runtime/mefisto-run-agent.sh"
CLAUDE_LIB="$LIB_DIR/runtime-claude.sh"
CLAUDE_JQ="$LIB_DIR/runtime-claude.jq"
SCHEMA_FILE="$CONTRACT_DIR/run-events.schema.json"
JSONSCHEMA_LITE="$INTERNAL_SCRIPTS/lib/jsonschema-lite.jq"
FIXTURES_DIR="$SCRIPT_DIR/fixtures/runtime-claude"

# El runner (mefisto-run-agent.sh) resuelve la lib de adaptador via
# MEFISTO_RUNTIME_LIB_DIR (mefisto-runtime.sh), que respeta un valor ya
# EXPORTADO por el caller. Los pipelines internos la exportan apuntando al
# checkout donde arrancaron, asi que sin pinearla aqui el bloque del runner
# real traduciria con el adaptador de OTRO checkout (el principal) en vez del
# que este test esta juzgando: un gate no determinista que da por bueno
# codigo que nunca ejecuto (MEF-ADR-0031). test-mefisto-run-agent.sh ya la
# controla por el mismo motivo.
export MEFISTO_RUNTIME_LIB_DIR="$LIB_DIR"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# translate_fixture <fixture.jsonl> [model] [exit_code] [stderr_file] -- corre
# runtime_claude_translate directo (sin pasar por el runner) contra un
# fixture, imprime el JSONL. <exit_code>/<stderr_file> vacios ejercen el
# degradado documentado (el adaptador solo afirma lo que el stream permite).
translate_fixture() {
    local fixture="$1" model="${2:-}" exit_code="${3:-}" stderr_file="${4:-}"
    runtime_claude_translate "$FIXTURES_DIR/$fixture" "claude" "$model" "$exit_code" "$stderr_file"
}

# validate_event_line <json-line> -- mismo patron que
# test-mefisto-run-agent.sh: valida contra definitions[.type].
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
            printf '%s' "$line" | jq -e 'has("estimated_cost_usd") or has("cost_usd")' >/dev/null 2>&1 || return 1
            ;;
    esac
    return 0
}

count_terminals() {
    jq -c 'select(.type == "run.completed" or .type == "run.failed")' "$1" 2>/dev/null | wc -l | tr -d ' '
}

check_all_lines_valid() {
    local name="$1" file="$2"
    local bad=0 line reason
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        if ! reason="$(validate_event_line "$line")"; then
            bad=1
            echo "    linea invalida: $reason"
        fi
    done < "$file"
    if [ "$bad" -eq 0 ]; then
        pass "$name: todas las lineas validan contra el schema"
    else
        fail "$name: alguna linea no valido (ver arriba)"
    fi
}

echo "[pre] Archivos nuevos existen, sintaxis valida"

for f in "$CLAUDE_LIB" "$CLAUDE_JQ"; do
    if [ -f "$f" ]; then
        pass "existe: ${f#"$REPO_ROOT"/}"
    else
        fail "no existe: ${f#"$REPO_ROOT"/}"
    fi
done

if bash -n "$CLAUDE_LIB" 2>/dev/null; then
    pass "sintaxis bash valida: ${CLAUDE_LIB#"$REPO_ROOT"/}"
else
    fail "sintaxis bash invalida: ${CLAUDE_LIB#"$REPO_ROOT"/}"
fi

# shellcheck source=/dev/null
source "$CLAUDE_LIB" 2>/dev/null
for fn in runtime_claude_build_cmd runtime_claude_translate runtime_claude_supports_resume runtime_claude_interactive_refresh; do
    if declare -F "$fn" >/dev/null 2>&1; then
        pass "$fn definida"
    else
        fail "$fn NO definida"
    fi
done

if OUT="$(translate_fixture success.jsonl)" && [ -n "$OUT" ]; then
    pass "runtime-claude.jq corre sin errores (stderr silenciado, exit 0)"
else
    fail "runtime-claude.jq fallo al correr contra success.jsonl"
fi

# ============================================================================
echo ""
echo "[A] CA-1: runtime_claude_build_cmd compone el argv completo, sin eval"

PROMPT_PLAIN="$TMP/prompt-plain.txt"
printf 'Instrucciones de prueba.' > "$PROMPT_PLAIN"
SYSTEM_FILE="$TMP/system.txt"
printf 'You are running in non-interactive print mode.' > "$SYSTEM_FILE"

MEFISTO_RUNTIME_CMD=()
MEFISTO_RUNTIME_STDIN_FILE=""
runtime_claude_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "sonnet" "$SYSTEM_FILE"

if [ "${MEFISTO_RUNTIME_CMD[0]}" = "claude" ] && [ "${MEFISTO_RUNTIME_CMD[1]}" = "-p" ]; then
    pass "A-1: el argv arranca con 'claude -p'"
else
    fail "A-1: el argv no arranca con 'claude -p': ${MEFISTO_RUNTIME_CMD[*]}"
fi

# A-2 (CA-1/CA-5, issue #1448): ni el contenido del prompt ni el del
# system-file aparecen en NINGUN elemento del argv -- el prompt SOLO viaja
# por MEFISTO_RUNTIME_STDIN_FILE.
argv_contains_needle() {
    local needle="$1" e
    for e in "${MEFISTO_RUNTIME_CMD[@]}"; do
        case "$e" in *"$needle"*) return 0 ;; esac
    done
    return 1
}
if ! argv_contains_needle "Instrucciones de prueba."; then
    pass "A-2: el contenido del prompt no aparece en ningun elemento del argv"
else
    fail "A-2: el contenido del prompt aparecio en el argv: ${MEFISTO_RUNTIME_CMD[*]}"
fi

if [ "$MEFISTO_RUNTIME_STDIN_FILE" = "$PROMPT_PLAIN" ]; then
    pass "A-2b: MEFISTO_RUNTIME_STDIN_FILE apunta a --prompt-file tal cual, sin releerlo"
else
    fail "A-2b: MEFISTO_RUNTIME_STDIN_FILE='$MEFISTO_RUNTIME_STDIN_FILE' (se esperaba '$PROMPT_PLAIN')"
fi

contains_pair() {
    # contains_pair <flag> <valor> -- true si el array MEFISTO_RUNTIME_CMD
    # trae <flag> inmediatamente seguido de <valor>.
    local flag="$1" value="$2" i
    for ((i=0; i<${#MEFISTO_RUNTIME_CMD[@]}-1; i++)); do
        if [ "${MEFISTO_RUNTIME_CMD[$i]}" = "$flag" ] && [ "${MEFISTO_RUNTIME_CMD[$((i+1))]}" = "$value" ]; then
            return 0
        fi
    done
    return 1
}

contains_elem() {
    local needle="$1" e
    for e in "${MEFISTO_RUNTIME_CMD[@]}"; do
        [ "$e" = "$needle" ] && return 0
    done
    return 1
}

if contains_elem "--permission-mode" && contains_pair "--permission-mode" "bypassPermissions"; then
    pass "A-3: --permission-mode bypassPermissions presente"
else
    fail "A-3: falta --permission-mode bypassPermissions: ${MEFISTO_RUNTIME_CMD[*]}"
fi

if contains_elem "--output-format" && contains_pair "--output-format" "stream-json" && contains_elem "--verbose"; then
    pass "A-4: --output-format stream-json --verbose presente"
else
    fail "A-4: falta --output-format stream-json --verbose: ${MEFISTO_RUNTIME_CMD[*]}"
fi

if contains_pair "--agent" "writer"; then
    pass "A-4b: --agent writer presente siempre"
else
    fail "A-4b: falta --agent writer: ${MEFISTO_RUNTIME_CMD[*]}"
fi

if contains_pair "--model" "sonnet"; then
    pass "A-5: --model sonnet presente cuando se recibe modelo no vacio"
else
    fail "A-5: falta --model sonnet: ${MEFISTO_RUNTIME_CMD[*]}"
fi

if contains_pair "--append-system-prompt-file" "$SYSTEM_FILE"; then
    pass "A-6: --append-system-prompt-file con la RUTA de --system-file (nunca su contenido)"
else
    fail "A-6: falta --append-system-prompt-file correcto: ${MEFISTO_RUNTIME_CMD[*]}"
fi
if ! argv_contains_needle "You are running in non-interactive print mode."; then
    pass "A-6b: el contenido de --system-file no aparece en ningun elemento del argv"
else
    fail "A-6b: el contenido de --system-file aparecio en el argv: ${MEFISTO_RUNTIME_CMD[*]}"
fi

# Modelo vacio (heredar, CA-1 de #858): NUNCA debe verse --model en el argv.
MEFISTO_RUNTIME_CMD=()
runtime_claude_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" ""
if ! contains_elem "--model"; then
    pass "A-7: modelo vacio (heredar) -> ningun --model en el argv"
else
    fail "A-7: modelo vacio pero el argv trae --model: ${MEFISTO_RUNTIME_CMD[*]}"
fi
if ! contains_elem "--append-system-prompt-file"; then
    pass "A-8: --system-file vacio -> ningun --append-system-prompt-file en el argv"
else
    fail "A-8: --system-file vacio pero el argv trae --append-system-prompt-file: ${MEFISTO_RUNTIME_CMD[*]}"
fi

# El prompt puede traer backticks/$()/comillas -- sin eval, viajan intactos
# solo por MEFISTO_RUNTIME_STDIN_FILE, nunca por argv.
PROMPT_DANGEROUS="$TMP/prompt-dangerous.txt"
printf 'Linea con `comando`, $(echo pwned) y "comillas".' > "$PROMPT_DANGEROUS"
MEFISTO_RUNTIME_CMD=()
MEFISTO_RUNTIME_STDIN_FILE=""
runtime_claude_build_cmd "writer" "$TMP" "$PROMPT_DANGEROUS" "" ""
if ! argv_contains_needle '`comando`' && [ "$MEFISTO_RUNTIME_STDIN_FILE" = "$PROMPT_DANGEROUS" ]; then
    pass "A-9: backticks/\$()/comillas del prompt nunca tocan el argv -- MEFISTO_RUNTIME_STDIN_FILE apunta al archivo intacto"
else
    fail "A-9: el prompt peligroso aparecio en argv o STDIN_FILE no coincide: argv=${MEFISTO_RUNTIME_CMD[*]} stdin=$MEFISTO_RUNTIME_STDIN_FILE"
fi

# Modelo opaco con '[1m]' -- el adaptador nunca lo interpreta, solo lo reenvia.
MEFISTO_RUNTIME_CMD=()
runtime_claude_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "claude-opus-5[1m]" ""
if contains_pair "--model" "claude-opus-5[1m]"; then
    pass "A-10: modelo opaco con '[1m]' reenviado literal"
else
    fail "A-10: el modelo opaco no llego intacto: ${MEFISTO_RUNTIME_CMD[*]}"
fi

# --- Reanudacion de sesion (issue #968) ---

MEFISTO_RUNTIME_CMD=()
runtime_claude_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" "" "sess-abc-123"
if contains_pair "--resume" "sess-abc-123"; then
    pass "A-11: resume_session_id no vacio -> --resume <id> en el argv"
else
    fail "A-11: falta --resume sess-abc-123: ${MEFISTO_RUNTIME_CMD[*]}"
fi

MEFISTO_RUNTIME_CMD=()
runtime_claude_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" "" ""
if ! contains_elem "--resume"; then
    pass "A-12: resume_session_id vacio (o ausente) -> ningun --resume en el argv (byte a byte igual a antes de #968)"
else
    fail "A-12: resume_session_id vacio pero el argv trae --resume: ${MEFISTO_RUNTIME_CMD[*]}"
fi

# --- Effort (issue #2496) ---

MEFISTO_RUNTIME_CMD=()
runtime_claude_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" "" "" "high"
if [ "${MEFISTO_RUNTIME_CMD[0]:-}" = "env" ] && [ "${MEFISTO_RUNTIME_CMD[1]:-}" = "CLAUDE_CODE_EFFORT_LEVEL=high" ] && [ "${MEFISTO_RUNTIME_CMD[2]:-}" = "claude" ] && [ "${MEFISTO_RUNTIME_CMD[3]:-}" = "-p" ] && ! contains_elem "--effort"; then
    pass "A-14: effort high -> argv empieza por env CLAUDE_CODE_EFFORT_LEVEL=high claude -p y no trae --effort"
else
    fail "A-14: argv inesperado con effort high: ${MEFISTO_RUNTIME_CMD[*]}"
fi

for _eff_case in "empty" "absent"; do
    MEFISTO_RUNTIME_CMD=()
    if [ "$_eff_case" = "empty" ]; then
        runtime_claude_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" "" "" ""
    else
        runtime_claude_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" "" ""
    fi
    if [ "${MEFISTO_RUNTIME_CMD[0]:-}" = "claude" ] && [ "${MEFISTO_RUNTIME_CMD[1]:-}" = "-p" ] && ! contains_elem "env" && ! contains_elem "--effort"; then
        pass "A-15 ($_eff_case): effort vacio/ausente -> argv empieza por claude -p, sin env ni --effort"
    else
        fail "A-15 ($_eff_case): argv inesperado sin effort: ${MEFISTO_RUNTIME_CMD[*]}"
    fi
done

if runtime_claude_supports_resume; then
    pass "A-13: runtime_claude_supports_resume retorna 0 (Claude Code soporta reanudacion)"
else
    fail "A-13: runtime_claude_supports_resume deberia retornar 0"
fi

printf '%s\n' 'prompt /reload-plugins' > "$TMP/refresh-expected"
if runtime_claude_interactive_refresh > "$TMP/refresh-actual" \
    && cmp -s "$TMP/refresh-expected" "$TMP/refresh-actual"; then
    pass "A-14: runtime_claude_interactive_refresh imprime exactamente una linea 'prompt /reload-plugins' sin invocar el CLI"
else
    REFRESH_OUTPUT="$(runtime_claude_interactive_refresh 2>/dev/null)"
    fail "A-14: refresh interactivo Claude inesperado: '$REFRESH_OUTPUT'"
fi

# --- Raiz de la release del pipeline (MEF-ADR-0053 decision 2) ---

PLUGIN_ROOT_OK="$TMP/release-claude"
mkdir -p "$PLUGIN_ROOT_OK/.claude-plugin"
printf '{"name":"mefisto","version":"0.0.0"}' > "$PLUGIN_ROOT_OK/.claude-plugin/plugin.json"

MEFISTO_RUNTIME_CMD=()
MEFISTO_AGENT_PACKAGE_ROOT="$PLUGIN_ROOT_OK" runtime_claude_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" ""
if contains_pair "--plugin-dir" "$PLUGIN_ROOT_OK"; then
    pass "A-15: MEFISTO_AGENT_PACKAGE_ROOT con .claude-plugin/plugin.json -> --plugin-dir <raiz>"
else
    fail "A-15: falta --plugin-dir $PLUGIN_ROOT_OK: ${MEFISTO_RUNTIME_CMD[*]}"
fi

MEFISTO_RUNTIME_CMD=()
MEFISTO_AGENT_PACKAGE_ROOT="$TMP" runtime_claude_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" ""
if ! contains_elem "--plugin-dir"; then
    pass "A-16: raiz sin .claude-plugin/plugin.json -> ningun --plugin-dir"
else
    fail "A-16: --plugin-dir con una raiz que no es plugin: ${MEFISTO_RUNTIME_CMD[*]}"
fi

MEFISTO_RUNTIME_CMD=()
(unset MEFISTO_AGENT_PACKAGE_ROOT; runtime_claude_build_cmd "writer" "$TMP" "$PROMPT_PLAIN" "" ""; printf '%s\n' "${MEFISTO_RUNTIME_CMD[@]}") > "$TMP/argv-sin-raiz"
if ! grep -qx -- "--plugin-dir" "$TMP/argv-sin-raiz"; then
    pass "A-17: sin MEFISTO_AGENT_PACKAGE_ROOT (pipelines internos) -> ningun --plugin-dir"
else
    fail "A-17: --plugin-dir sin MEFISTO_AGENT_PACKAGE_ROOT: $(tr '\n' ' ' < "$TMP/argv-sin-raiz")"
fi

# ============================================================================
echo ""
echo "[B] CA-2: mapeo de eventos (assistant/text->message, tool_use->tool.started, tool_result->tool.completed)"

B_OUT="$TMP/b-success.jsonl"
translate_fixture success.jsonl > "$B_OUT"

if [ "$(jq -r 'select(.type=="message") | .text' "$B_OUT" | sed -n '1p')" = "Voy a investigar." ] \
   && [ "$(jq -r 'select(.type=="message") | .text' "$B_OUT" | sed -n '2p')" = "Listo, hice el cambio." ]; then
    pass "B-1: los dos bloques 'text' del assistant se tradujeron a message{role:assistant}, en orden"
else
    fail "B-1: los mensajes traducidos no coinciden: $(jq -c 'select(.type=="message")' "$B_OUT")"
fi

if jq -e 'select(.type=="tool.started") | .tool == "Read" and .input_summary == "x"' "$B_OUT" >/dev/null 2>&1; then
    pass "B-2: el bloque tool_use se tradujo a tool.started{tool:'Read', input_summary:'x'} (issue #863: file_path puebla input_summary)"
else
    fail "B-2: no se encontro el tool.started esperado: $(jq -c 'select(.type=="tool.started")' "$B_OUT")"
fi

if jq -e 'select(.type=="tool.completed") | .tool == "Read" and .ok == true and .duration_ms == 200' "$B_OUT" >/dev/null 2>&1; then
    pass "B-3: el tool_result se tradujo a tool.completed{tool:'Read', ok:true, duration_ms:200} (emparejado por id)"
else
    fail "B-3: no se encontro el tool.completed esperado: $(jq -c 'select(.type=="tool.completed")' "$B_OUT")"
fi

if [ "$(grep -c '"type":"system"' "$B_OUT")" = "0" ]; then
    pass "B-4: el evento system/init nunca se re-emite como linea propia (nunca 'run.started' desde el adaptador)"
else
    fail "B-4: el adaptador emitio una linea espuria del evento system/init"
fi

if [ "$(grep -c '"type":"run.started"' "$B_OUT")" = "0" ]; then
    pass "B-5: runtime_claude_translate nunca emite 'run.started' (responsabilidad exclusiva del runner)"
else
    fail "B-5: el adaptador emitio 'run.started' -- viola la interfaz de #858"
fi

# ============================================================================
echo ""
echo "[C] CA-3: clasificacion de fallo y criterio de exito de tres condiciones"

C_SUCCESS="$TMP/c-success.jsonl"; translate_fixture success.jsonl > "$C_SUCCESS"
if jq -e 'select(.type=="run.completed") | .status == "success" and .error == null' "$C_SUCCESS" >/dev/null 2>&1; then
    pass "C-1: is_error==false + subtype==success + stop_reason==end_turn -> run.completed{status:success}"
else
    fail "C-1: el fixture de exito no produjo el terminal esperado: $(jq -c 'select(.type=="run.completed" or .type=="run.failed")' "$C_SUCCESS")"
fi

C_529="$TMP/c-529.jsonl"; translate_fixture api-error-529.jsonl > "$C_529"
if jq -e 'select(.type=="run.failed") | .status == "failed" and .error.kind == "provider_unavailable" and (.error.detail | contains("529"))' "$C_529" >/dev/null 2>&1; then
    pass "C-2: result.is_error con api_error_status:529 -> run.failed{error.kind:provider_unavailable, detail con '529'} (issue #965)"
else
    fail "C-2: no se clasifico el 529 como se esperaba: $(jq -c 'select(.type=="run.failed")' "$C_529")"
fi

C_RATELIMIT="$TMP/c-ratelimit.jsonl"; translate_fixture rate-limit-exhausted.jsonl "" 1 > "$C_RATELIMIT"
if jq -e 'select(.type=="run.failed") | .error.kind == "rate_limit" and .resets_at == "2026-05-07T22:40:00Z"' "$C_RATELIMIT" >/dev/null 2>&1; then
    pass "C-2b: rate_limit_event{status:rejected} -> run.failed{error.kind:rate_limit, resets_at poblado} (issue #965)"
else
    fail "C-2b: no se clasifico la ventana agotada como se esperaba: $(jq -c 'select(.type=="run.failed")' "$C_RATELIMIT")"
fi

C_404="$TMP/c-404.jsonl"; translate_fixture api-error-404.jsonl > "$C_404"
if jq -e 'select(.type=="run.failed") | .error.kind == "api_error" and (.error.detail | contains("404"))' "$C_404" >/dev/null 2>&1; then
    pass "C-3: result.is_error con api_error_status:404 -> run.failed{error.kind:api_error, detail con '404'}"
else
    fail "C-3: no se clasifico el 404 como se esperaba: $(jq -c 'select(.type=="run.failed")' "$C_404")"
fi

C_CUT="$TMP/c-cut.jsonl"; translate_fixture stream-truncated.jsonl > "$C_CUT"
if jq -e 'select(.type=="run.failed") | .error.kind == "stream_cut"' "$C_CUT" >/dev/null 2>&1; then
    pass "C-4: stream sin result, ultima linea truncada -> run.failed{error.kind:stream_cut}"
else
    fail "C-4: no se clasifico el corte de stream: $(jq -c 'select(.type=="run.failed")' "$C_CUT")"
fi

C_NORESULT="$TMP/c-noresult.jsonl"; translate_fixture killed-no-result.jsonl > "$C_NORESULT"
if jq -e 'select(.type=="run.failed") | .error.kind == "no_result"' "$C_NORESULT" >/dev/null 2>&1; then
    pass "C-5: stream sin result, ultima linea SI parseo -> run.failed{error.kind:no_result}"
else
    fail "C-5: no se clasifico como no_result: $(jq -c 'select(.type=="run.failed")' "$C_NORESULT")"
fi

# --- Clasificacion que SOLO es posible con el exit code y el stderr ---------
# Sin esos dos datos, `killed`, el `API Error: <status>` que Claude escribe
# unicamente por stderr (#425) y `nonzero_exit` son indistinguibles de un
# stream que termino sin declarar nada: por eso la interfaz de traduccion
# acepta los dos argumentos opcionales (ver src/internal/contract/README.md).

C_KILLED="$TMP/c-killed.jsonl"; translate_fixture killed-no-result.jsonl "" 137 > "$C_KILLED"
if jq -e 'select(.type=="run.failed") | .error.kind == "killed" and (.error.detail | contains("137"))' "$C_KILLED" >/dev/null 2>&1; then
    pass "C-7: exit 137 sin result -> run.failed{error.kind:killed} (gana sobre no_result, orden de classify_agent_failure)"
else
    fail "C-7: no se clasifico el exit 137 como killed: $(jq -c 'select(.type=="run.failed")' "$C_KILLED")"
fi

C_KILLED143="$TMP/c-killed143.jsonl"; translate_fixture killed-no-result.jsonl "" 143 > "$C_KILLED143"
if jq -e 'select(.type=="run.failed") | .error.kind == "killed"' "$C_KILLED143" >/dev/null 2>&1; then
    pass "C-8: exit 143 (SIGTERM) -> run.failed{error.kind:killed}"
else
    fail "C-8: no se clasifico el exit 143 como killed: $(jq -c 'select(.type=="run.failed")' "$C_KILLED143")"
fi

# PR #446: el exito declarado gana sobre la senal posterior, y la senal queda
# documentada en `error` sin degradar el status (caso que el $comment de
# `error` en run-events.schema.json reconoce explicitamente).
C_POST="$TMP/c-post-success.jsonl"; translate_fixture success.jsonl "" 137 > "$C_POST"
if jq -e 'select(.type=="run.completed") | .status == "success" and .error.kind == "killed"' "$C_POST" >/dev/null 2>&1; then
    pass "C-9: exito declarado + exit 137 -> run.completed{status:success, error.kind:killed} (muerte POSTERIOR, PR #446)"
else
    fail "C-9: el exito declarado no sobrevivio al exit 137: $(jq -c 'select(.type=="run.completed" or .type=="run.failed")' "$C_POST")"
fi

STDERR_5XX="$TMP/stderr-5xx.log"; printf 'ruido previo\nAPI Error: 500 Internal Server Error\n' > "$STDERR_5XX"
C_STDERR5="$TMP/c-stderr5.jsonl"; translate_fixture killed-no-result.jsonl "" 1 "$STDERR_5XX" > "$C_STDERR5"
if jq -e 'select(.type=="run.failed") | .error.kind == "provider_unavailable" and (.error.detail | contains("500"))' "$C_STDERR5" >/dev/null 2>&1; then
    pass "C-10: 'API Error: 500' solo en stderr -> run.failed{error.kind:provider_unavailable} con el status en el detalle (issue #965)"
else
    fail "C-10: no se leyo el API Error del stderr: $(jq -c 'select(.type=="run.failed")' "$C_STDERR5")"
fi

STDERR_MIX="$TMP/stderr-mix.log"; printf 'API Error: 400 Bad Request\nAPI Error: 529 Overloaded\n' > "$STDERR_MIX"
C_STDERRMIX="$TMP/c-stderrmix.jsonl"; translate_fixture killed-no-result.jsonl "" 1 "$STDERR_MIX" > "$C_STDERRMIX"
if jq -e 'select(.type=="run.failed") | .error.kind == "provider_unavailable" and (.error.detail | contains("529"))' "$C_STDERRMIX" >/dev/null 2>&1; then
    pass "C-11: con 4xx y 5xx en el mismo stderr gana el 5xx -> provider_unavailable (issue #965)"
else
    fail "C-11: el 5xx no gano sobre el 4xx: $(jq -c 'select(.type=="run.failed")' "$C_STDERRMIX")"
fi

STDERR_CUT="$TMP/stderr-cut.log"; printf 'Connection closed mid-response\n' > "$STDERR_CUT"
C_STDERRCUT="$TMP/c-stderrcut.jsonl"; translate_fixture killed-no-result.jsonl "" 1 "$STDERR_CUT" > "$C_STDERRCUT"
if jq -e 'select(.type=="run.failed") | .error.kind == "stream_cut"' "$C_STDERRCUT" >/dev/null 2>&1; then
    pass "C-12: 'Connection closed mid-response' en stderr (el patron historico del corte, #416) -> stream_cut"
else
    fail "C-12: no se clasifico el corte anunciado por stderr: $(jq -c 'select(.type=="run.failed")' "$C_STDERRCUT")"
fi

C_MAXTURNS="$TMP/c-maxturns.jsonl"; translate_fixture result-max-turns.jsonl "" 1 > "$C_MAXTURNS"
if jq -e 'select(.type=="run.failed") | .error.kind == "nonzero_exit" and (.error.detail | contains("max_turns"))' "$C_MAXTURNS" >/dev/null 2>&1; then
    pass "C-13: result sin is_error que tampoco declara exito (subtype error_max_turns) -> nonzero_exit"
else
    fail "C-13: no se clasifico el result no-exitoso como nonzero_exit: $(jq -c 'select(.type=="run.failed")' "$C_MAXTURNS")"
fi

for f in "$C_SUCCESS" "$C_529" "$C_404" "$C_CUT" "$C_NORESULT" \
         "$C_KILLED" "$C_KILLED143" "$C_POST" "$C_STDERR5" "$C_STDERRMIX" "$C_STDERRCUT" "$C_MAXTURNS"; do
    T=$(count_terminals "$f")
    if [ "$T" = "1" ]; then
        pass "C-6 ($(basename "$f")): exactamente 1 evento terminal"
    else
        fail "C-6 ($(basename "$f")): se contaron $T eventos terminales (se esperaba 1)"
    fi
done

# ============================================================================
echo ""
echo "[D] CA-4: el terminal preserva las cifras cuando Claude las entrega; ausentes -> null, nunca 0"

D_FULL="$TMP/d-full.jsonl"; translate_fixture success.jsonl > "$D_FULL"
assert_field() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$actual" = "$expected" ]; then
        pass "$desc"
    else
        fail "$desc (esperado '$expected', obtenido '$actual')"
    fi
}
TERM_FULL="$(jq -c 'select(.type=="run.completed")' "$D_FULL")"
assert_field "D-1: session_id" "sess-abc" "$(echo "$TERM_FULL" | jq -r '.session_id')"
assert_field "D-2: tokens.input" "100" "$(echo "$TERM_FULL" | jq -r '.tokens.input')"
assert_field "D-3: tokens.output" "50" "$(echo "$TERM_FULL" | jq -r '.tokens.output')"
assert_field "D-4: estimated_cost_usd" "0.01" "$(echo "$TERM_FULL" | jq -r '.estimated_cost_usd')"
assert_field "D-4b: tokens.cache_read" "11" "$(echo "$TERM_FULL" | jq -r '.tokens.cache_read')"
assert_field "D-4c: tokens.cache_write" "12" "$(echo "$TERM_FULL" | jq -r '.tokens.cache_write')"
assert_field "D-4d: tokens.reasoning" "null" "$(echo "$TERM_FULL" | jq -r '.tokens.reasoning')"
assert_field "D-4e: el escritor no emite cost_usd legacy" "false" "$(echo "$TERM_FULL" | jq 'has("cost_usd")')"
assert_field "D-5: turns" "2" "$(echo "$TERM_FULL" | jq -r '.turns')"
assert_field "D-6: ttft_ms" "300" "$(echo "$TERM_FULL" | jq -r '.ttft_ms')"
assert_field "D-7: denials (cardinalidad, no el arreglo)" "1" "$(echo "$TERM_FULL" | jq -r '.denials')"
assert_field "D-8: api_duration_ms" "1500" "$(echo "$TERM_FULL" | jq -r '.api_duration_ms')"

D_MIN="$TMP/d-min.jsonl"; translate_fixture success-minimal.jsonl > "$D_MIN"
TERM_MIN="$(jq -c 'select(.type=="run.completed")' "$D_MIN")"
assert_field "D-9: session_id ausente -> null" "null" "$(echo "$TERM_MIN" | jq -r '.session_id')"
assert_field "D-10: tokens.input ausente -> null" "null" "$(echo "$TERM_MIN" | jq -r '.tokens.input')"
assert_field "D-11: estimated_cost_usd ausente -> null" "null" "$(echo "$TERM_MIN" | jq -r '.estimated_cost_usd')"
assert_field "D-11b: el escritor minimal tampoco emite cost_usd legacy" "false" "$(echo "$TERM_MIN" | jq 'has("cost_usd")')"
assert_field "D-12: turns ausente -> null" "null" "$(echo "$TERM_MIN" | jq -r '.turns')"
assert_field "D-13: ttft_ms ausente -> null" "null" "$(echo "$TERM_MIN" | jq -r '.ttft_ms')"
assert_field "D-14: denials ausente -> null (nunca 0)" "null" "$(echo "$TERM_MIN" | jq -r '.denials')"
assert_field "D-15: api_duration_ms ausente -> null" "null" "$(echo "$TERM_MIN" | jq -r '.api_duration_ms')"

# ============================================================================
echo ""
echo "[E] CA-5: --raw-log conserva la traza cruda intacta"

WORKDIR="$TMP/wt-e"; mkdir -p "$WORKDIR"
PROMPT_FILE="$TMP/prompt-e.txt"; echo "prompt" > "$PROMPT_FILE"
STUB_BIN="$TMP/bin-stub"; mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/claude" <<'STUBEOF'
#!/usr/bin/env bash
if [ -n "${MEFISTO_CLAUDE_STUB_ARGS_FILE:-}" ]; then
    : > "$MEFISTO_CLAUDE_STUB_ARGS_FILE"
    for a in "$@"; do
        printf '%s\n' "$a" >> "$MEFISTO_CLAUDE_STUB_ARGS_FILE"
    done
fi
if [ -n "${MEFISTO_CLAUDE_STUB_SLEEP:-}" ]; then
    sleep "$MEFISTO_CLAUDE_STUB_SLEEP"
fi
# CA-4 (issue #1448): [ -t 0 ] ANTES de leer nada de stdin -- mismo orden que
# runtime-fake.sh dump-stdin (#1447). Vuelca stdin BYTE A BYTE a
# MEFISTO_CLAUDE_STUB_STDIN_FILE (o la descarta si no se pidio) y deja
# constancia de si era TTY en un archivo hermano "<STDIN_FILE>.tty".
if [ -n "${MEFISTO_CLAUDE_STUB_STDIN_FILE:-}" ]; then
    STDIN_IS_TTY=0
    [ -t 0 ] && STDIN_IS_TTY=1
    printf '%s\n' "$STDIN_IS_TTY" > "${MEFISTO_CLAUDE_STUB_STDIN_FILE}.tty"
    cat > "$MEFISTO_CLAUDE_STUB_STDIN_FILE"
else
    cat > /dev/null
fi
if [ -n "${MEFISTO_CLAUDE_STUB_FIXTURE:-}" ] && [ -f "$MEFISTO_CLAUDE_STUB_FIXTURE" ]; then
    cat "$MEFISTO_CLAUDE_STUB_FIXTURE"
fi
# stdout y stderr separados, como el CLI real (#425): el `API Error` de un
# fallo de transporte solo aparece por este canal.
if [ -n "${MEFISTO_CLAUDE_STUB_STDERR:-}" ]; then
    printf '%s\n' "$MEFISTO_CLAUDE_STUB_STDERR" >&2
fi
exit "${MEFISTO_CLAUDE_STUB_EXIT:-0}"
STUBEOF
chmod +x "$STUB_BIN/claude"

ORIG_PATH="$PATH"
export PATH="$STUB_BIN:$PATH"
unset MEFISTO_RUNTIME

E_RAW="$TMP/e-raw.log"
E_EVENTS="$TMP/e-events.jsonl"
MEFISTO_CLAUDE_STUB_FIXTURE="$FIXTURES_DIR/success.jsonl" MEFISTO_CLAUDE_STUB_EXIT=0 \
    "$RUNNER" --runtime claude --agent test-agent --cwd "$WORKDIR" \
    --prompt-file "$PROMPT_FILE" --event-log "$E_EVENTS" --raw-log "$E_RAW" >/dev/null 2>&1

if [ -f "$E_RAW" ] && diff -q "$E_RAW" "$FIXTURES_DIR/success.jsonl" >/dev/null 2>&1; then
    pass "E-1: --raw-log conserva la traza cruda intacta, byte a byte igual al fixture"
else
    fail "E-1: --raw-log no coincide con la traza cruda esperada"
fi

# ============================================================================
echo ""
echo "[F] CA-6: runner real (mefisto-run-agent.sh --runtime claude) contra la CLI falsa"

run_claude_scenario() {
    # run_claude_scenario <event_log> [args del runner...]
    local ev="$1"; shift
    "$RUNNER" --runtime claude --agent test-agent --cwd "$WORKDIR" \
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

    check_all_lines_valid "$desc" "$ev"

    local terms
    terms=$(count_terminals "$ev")
    if [ "$terms" = "1" ]; then
        pass "$desc: exactamente 1 evento terminal en --event-log"
    else
        fail "$desc: se contaron $terms eventos terminales (se esperaba 1)"
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

F_EV="$TMP/f-success.jsonl"
F_ARGS="$TMP/f-agent.args"
RC=$(MEFISTO_CLAUDE_STUB_FIXTURE="$FIXTURES_DIR/success.jsonl" MEFISTO_CLAUDE_STUB_EXIT=0 MEFISTO_CLAUDE_STUB_ARGS_FILE="$F_ARGS" run_claude_scenario "$F_EV")
check_scenario "exito" "$F_EV" 0 "success" "" "$RC"
if [ -f "$F_ARGS" ] && grep -A1 -xF -- "--agent" "$F_ARGS" | tail -n1 | grep -qxF "test-agent"; then
    pass "exito: la CLI falsa recibe --agent test-agent"
else
    fail "exito: la CLI falsa no recibio --agent test-agent: $(cat "$F_ARGS" 2>/dev/null)"
fi

F_EV="$TMP/f-529.jsonl"
RC=$(MEFISTO_CLAUDE_STUB_FIXTURE="$FIXTURES_DIR/api-error-529.jsonl" MEFISTO_CLAUDE_STUB_EXIT=1 run_claude_scenario "$F_EV")
check_scenario "is_error API Error: 529" "$F_EV" 1 "failed" "provider_unavailable" "$RC"

F_EV="$TMP/f-404.jsonl"
RC=$(MEFISTO_CLAUDE_STUB_FIXTURE="$FIXTURES_DIR/api-error-404.jsonl" MEFISTO_CLAUDE_STUB_EXIT=1 run_claude_scenario "$F_EV")
check_scenario "is_error API Error: 404" "$F_EV" 1 "failed" "api_error" "$RC"

F_EV="$TMP/f-stderr-500.jsonl"
RC=$(MEFISTO_CLAUDE_STUB_FIXTURE="$FIXTURES_DIR/killed-no-result.jsonl" MEFISTO_CLAUDE_STUB_STDERR="API Error: 500 Internal Server Error" MEFISTO_CLAUDE_STUB_EXIT=1 run_claude_scenario "$F_EV")
check_scenario "API Error: 500 solo por stderr" "$F_EV" 1 "failed" "provider_unavailable" "$RC"

F_EV="$TMP/f-ratelimit.jsonl"
RC=$(MEFISTO_CLAUDE_STUB_FIXTURE="$FIXTURES_DIR/rate-limit-exhausted.jsonl" MEFISTO_CLAUDE_STUB_EXIT=1 run_claude_scenario "$F_EV")
check_scenario "ventana de uso agotada (rate_limit_event, issue #965)" "$F_EV" 1 "failed" "rate_limit" "$RC"

F_EV="$TMP/f-truncated.jsonl"
RC=$(MEFISTO_CLAUDE_STUB_FIXTURE="$FIXTURES_DIR/stream-truncated.jsonl" MEFISTO_CLAUDE_STUB_EXIT=1 run_claude_scenario "$F_EV")
check_scenario "stream truncado" "$F_EV" 1 "failed" "stream_cut" "$RC"

F_EV="$TMP/f-timeout.jsonl"
RC=$(MEFISTO_CLAUDE_STUB_FIXTURE="$FIXTURES_DIR/success.jsonl" MEFISTO_CLAUDE_STUB_SLEEP=3600 run_claude_scenario "$F_EV" --timeout 1)
check_scenario "timeout (stub que duerme)" "$F_EV" 124 "timeout" "timeout" "$RC"

F_EV="$TMP/f-exit137.jsonl"
RC=$(MEFISTO_CLAUDE_STUB_FIXTURE="$FIXTURES_DIR/killed-no-result.jsonl" MEFISTO_CLAUDE_STUB_EXIT=137 run_claude_scenario "$F_EV")
check_scenario "exit 137 (senal externa, sin timeout del watchdog)" "$F_EV" 137 "failed" "killed" "$RC"

F_EV="$TMP/f-model-heredado.jsonl"
F_ARGS="$TMP/f-model-heredado.args"
RC=$(MEFISTO_CLAUDE_STUB_FIXTURE="$FIXTURES_DIR/success.jsonl" MEFISTO_CLAUDE_STUB_EXIT=0 MEFISTO_CLAUDE_STUB_ARGS_FILE="$F_ARGS" run_claude_scenario "$F_EV")
check_scenario "modelo heredado (sin --model)" "$F_EV" 0 "success" "" "$RC"
if [ -f "$F_ARGS" ] && ! grep -qxF -- "--model" "$F_ARGS"; then
    pass "modelo heredado: --model NO aparece en la linea de comando capturada"
else
    fail "modelo heredado: --model aparecio en la linea de comando capturada: $(cat "$F_ARGS" 2>/dev/null)"
fi

F_EV="$TMP/f-model-opaco.jsonl"
F_ARGS="$TMP/f-model-opaco.args"
RC=$(MEFISTO_CLAUDE_STUB_FIXTURE="$FIXTURES_DIR/success.jsonl" MEFISTO_CLAUDE_STUB_EXIT=0 MEFISTO_CLAUDE_STUB_ARGS_FILE="$F_ARGS" run_claude_scenario "$F_EV" --model "claude-opus-5[1m]")
check_scenario "modelo opaco con [1m]" "$F_EV" 0 "success" "" "$RC"
if [ -f "$F_ARGS" ] && grep -A1 -xF -- "--model" "$F_ARGS" | tail -n1 | grep -qxF "claude-opus-5[1m]"; then
    pass "modelo opaco: 'claude-opus-5[1m]' reenviado literal en la linea de comando capturada"
else
    fail "modelo opaco: no se encontro el modelo opaco intacto: $(cat "$F_ARGS" 2>/dev/null)"
fi

F_EV="$TMP/f-redacted.jsonl"
F_EVENTS="$TMP/f-redacted-events.log"
RC=$(MEFISTO_CLAUDE_STUB_FIXTURE="$FIXTURES_DIR/sensitive-redaction.jsonl" MEFISTO_CLAUDE_STUB_STDERR="STDERR_SENTINEL AUTH_TOKEN_SENTINEL" MEFISTO_CLAUDE_STUB_EXIT=0 run_claude_scenario "$F_EV" --events-log "$F_EVENTS" --redact-observability)
check_scenario "persistencia redactada Claude" "$F_EV" 0 "success" "" "$RC"
if [ -s "$F_EVENTS" ] \
    && ! grep -Eq 'PROMPT_SENTINEL|ASSISTANT_SENTINEL|COMMAND_SENTINEL|STDERR_SENTINEL|HEADER_SENTINEL|AUTH_TOKEN_SENTINEL' "$F_EV" "$F_EVENTS" \
    && ! jq -e 'select(.type == "message")' "$F_EV" >/dev/null 2>&1 \
    && jq -e 'select(.type == "tool.started") | .tool == "Bash" and .input_summary == null' "$F_EV" >/dev/null 2>&1 \
    && jq -e 'select(.type == "run.completed") | .runtime == "claude" and .model == "claude-sonnet-5" and .session_id == "sess-redaction-claude" and .tokens.input == 21 and .tokens.output == 8 and .tokens.cache_read == null and .tokens.cache_write == null and .tokens.reasoning == null and .estimated_cost_usd == 0.02 and (has("cost_usd") | not) and .turns == 2' "$F_EV" >/dev/null 2>&1; then
    pass "redaccion Claude elimina centinelas y conserva identidad/metricas/tools"
else
    fail "redaccion Claude filtro contenido sensible o perdio evidencia operacional"
fi

F_EV="$TMP/f-redacted-rate-limit.jsonl"
RC=$(MEFISTO_CLAUDE_STUB_FIXTURE="$FIXTURES_DIR/rate-limit-exhausted.jsonl" MEFISTO_CLAUDE_STUB_EXIT=1 run_claude_scenario "$F_EV" --redact-observability)
check_scenario "persistencia redactada Claude rate limit" "$F_EV" 1 "failed" "rate_limit" "$RC"
if jq -e 'select(.type == "run.failed") | .resets_at == "2026-05-07T22:40:00Z" and .error.detail == "detalle redactado: rate_limit"' "$F_EV" >/dev/null 2>&1; then
    pass "redaccion Claude conserva resets_at y sustituye error.detail"
else
    fail "redaccion Claude perdio resets_at o dejo error.detail sin redactar"
fi

# ============================================================================
echo ""
echo "[G] CA-3/CA-4: paridad ante ARG_MAX (issue #1448) -- el prompt viaja por stdin, nunca por argv"

G_ARG_MAX="$(getconf ARG_MAX 2>/dev/null)"
case "$G_ARG_MAX" in
    ''|*[!0-9]*)
        fail "G-0: getconf ARG_MAX no devolvio un entero ('$G_ARG_MAX')"
        G_ARG_MAX=0
        ;;
    *)
        pass "G-0: getconf ARG_MAX = $G_ARG_MAX"
        ;;
esac

G_SENTINEL="$(printf '%-64s' 'MEFISTO_1448_CLAUDE_SENTINEL')"
G_TARGET_SIZE=$((G_ARG_MAX + 65536))
G_BODY_SIZE=$((G_TARGET_SIZE - ${#G_SENTINEL}))
G_BLOCK="$TMP/g-block.txt"
printf 'linea con tab\tdolar $HOME y barra \\ y unicode: ñáéíóú 日本語\n' > "$G_BLOCK"
G_FIXTURE="$TMP/g-fixture-argmax.bin"
yes "$(cat "$G_BLOCK")" 2>/dev/null | head -c "$G_BODY_SIZE" > "$G_FIXTURE"
printf '%s' "$G_SENTINEL" >> "$G_FIXTURE"

G_FIXTURE_SIZE="$(wc -c < "$G_FIXTURE" | tr -d ' ')"
if [ "$G_FIXTURE_SIZE" -ge "$G_TARGET_SIZE" ]; then
    pass "G-1: fixture ARG_MAX = $G_FIXTURE_SIZE bytes (>= $G_TARGET_SIZE)"
else
    fail "G-1: fixture ARG_MAX = $G_FIXTURE_SIZE bytes (se esperaba >= $G_TARGET_SIZE)"
fi

G_EV="$TMP/g-event-log.jsonl"
G_DUMP="$TMP/g-stdin-dump.bin"
G_ARGS="$TMP/g-args.txt"
RC=$(MEFISTO_CLAUDE_STUB_FIXTURE="$FIXTURES_DIR/success.jsonl" MEFISTO_CLAUDE_STUB_EXIT=0 \
    MEFISTO_CLAUDE_STUB_ARGS_FILE="$G_ARGS" MEFISTO_CLAUDE_STUB_STDIN_FILE="$G_DUMP" \
    "$RUNNER" --runtime claude --agent test-agent --cwd "$WORKDIR" \
        --prompt-file "$G_FIXTURE" --event-log "$G_EV" --timeout 60 >/dev/null 2>&1; echo $?)

if [ "$RC" = "0" ]; then
    pass "G-2: el runner termina con exit 0 pese a un prompt >= ARG_MAX"
else
    fail "G-2: exit $RC (se esperaba 0)"
fi

G_TERMS=$(count_terminals "$G_EV")
if [ "$G_TERMS" = "1" ]; then
    pass "G-3: exactamente 1 evento terminal en --event-log"
else
    fail "G-3: se contaron $G_TERMS eventos terminales (se esperaba 1)"
fi

if [ -f "$G_DUMP" ] && cmp -s "$G_FIXTURE" "$G_DUMP"; then
    pass "G-4: el volcado de stdin del stub es identico byte a byte al fixture (cmp)"
else
    fail "G-4: el volcado de stdin difiere del fixture original"
fi

if [ -f "$G_ARGS" ] && ! grep -qF "$G_SENTINEL" "$G_ARGS"; then
    pass "G-5: el centinela del prompt NO aparece en el volcado de argv (nunca viajo por argv)"
else
    fail "G-5: el centinela aparecio en el volcado de argv: $(cat "$G_ARGS" 2>/dev/null)"
fi

if [ -f "${G_DUMP}.tty" ] && [ "$(cat "${G_DUMP}.tty")" = "0" ]; then
    pass "G-6: stdin del stub NO era TTY (el aislamiento de #943 se conserva con el canal de #1447/#1448)"
else
    fail "G-6: no se registro TTY=0 junto al volcado de stdin: $(cat "${G_DUMP}.tty" 2>/dev/null)"
fi

export PATH="$ORIG_PATH"

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
