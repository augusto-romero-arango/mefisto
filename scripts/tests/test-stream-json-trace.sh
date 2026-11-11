#!/usr/bin/env bash
# test-stream-json-trace.sh -- Tests de derive_stage_log_from_stream, la
# derivacion del .log legible de un stage a partir de la traza stream-json
# (issue #645, patron portado de .claude/scripts/_mefisto-common.sh).
#
# Contexto: tdd-pipeline.sh invocaba `claude -p` con `--output-format text`,
# asi que el log de stage solo guardaba el texto final del agente -- sin tool
# calls, turnos ni tokens que derivar metricas (issue #646/#647). El porte
# cambia la invocacion a `--output-format stream-json --verbose` con stdout y
# stderr en archivos separados, y deriva el .log de siempre (misma ruta, CA-2)
# con derive_stage_log_from_stream: texto del asistente + una linea
# "[tool] <nombre>" por tool call, con el stderr anexado al final. La
# clasificacion de fallos (classify_agent_failure en _pipeline-common.sh
# desde el issue #971: grep "API Error: 5"/"API Error: 4" sobre ese mismo
# .log) sigue leyendo el archivo sin cambios.
#
# A diferencia del test interno equivalente, este NO cubre
# run_agent_with_watchdog ni agent_log_has_stream_cut: el porte publicado
# deliberadamente no los trae (el wrapper publicado ya tiene su propio
# watchdog SIGKILL por process-group y su propio retry 5xx -- ver notas
# tecnicas del issue #645).
#
# Casos cubiertos:
#   [pre] derive_stage_log_from_stream esta definida en _pipeline-common.sh.
#   [A] Stream completo con tool calls -> el log derivado trae el texto del
#       asistente y una linea "[tool] <nombre>" por cada tool_use, en orden,
#       sin JSON crudo visible.
#   [B] Stream truncado a mitad de linea -> la linea incompleta se ignora sin
#       abortar el pipeline (set -euo pipefail activo) y el texto de las
#       lineas completas anteriores no se pierde (CA-5 del issue: el stream
#       de un stage matado por el watchdog queda truncado en disco).
#   [C] Traza vacia (stream vacio, sin stderr) -> no falla, log derivado vacio.
#   [D] .stderr.log con "API Error: 500"/"API Error: 400" -> el texto llega al
#       log derivado, en el mismo lugar que consultan los grep de
#       classify_agent_failure (_pipeline-common.sh).
#   [E] jq ausente -> degrada con gracia: no aborta, deja una nota legible y
#       de todos modos anexa el stderr (CA-4).
#   [G] Evento `result` con is_error y stderr VACIO -> el error igual llega al
#       log derivado (mismo caso real que motivo el patron interno: un CLI que
#       falla sin escribir nada por stderr). Incluye el caso negativo (un
#       `result` sano no debe ensuciar el log) y una linea de JSON valido pero
#       no-objeto, que no debe tumbar la derivacion.
#
# Uso: scripts/tests/test-stream-json-trace.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/_pipeline-common.sh" 2>/dev/null

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# -------- Bloque pre: la funcion existe --------

echo "[pre] derive_stage_log_from_stream esta definida en _pipeline-common.sh"
if declare -F derive_stage_log_from_stream >/dev/null; then
    pass "derive_stage_log_from_stream definida"
else
    fail "derive_stage_log_from_stream NO definida"
fi

# -------- Bloque A: stream completo con tool calls --------

echo ""
echo "[A] Stream completo con tool calls -> texto del asistente + una linea por tool call"

cat > "$TMP/a-stream.jsonl" <<'EOF'
{"type":"system","subtype":"init","session_id":"abc"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Voy a leer el archivo relevante."}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"x"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"contenido"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_2","name":"Write","input":{"file_path":"y"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_2","content":"ok"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"Listo, hice el cambio."}]}}
{"type":"result","num_turns":4,"duration_ms":4200,"duration_api_ms":3000,"total_cost_usd":0.02,"is_error":false}
EOF
: > "$TMP/a-stderr.log"

derive_stage_log_from_stream "$TMP/a-stream.jsonl" "$TMP/a-stderr.log" "$TMP/a-out.log"
RC=$?

if [ "$RC" -eq 0 ]; then
    pass "A-1: exit 0"
else
    fail "A-1: se esperaba exit 0, se obtuvo $RC"
fi

if grep -qF "Voy a leer el archivo relevante." "$TMP/a-out.log" && grep -qF "Listo, hice el cambio." "$TMP/a-out.log"; then
    pass "A-2: el texto del asistente (ambos turnos) llego al log derivado"
else
    fail "A-2: falta texto del asistente en el log derivado: $(cat "$TMP/a-out.log")"
fi

if grep -qF "[tool] Read" "$TMP/a-out.log" && grep -qF "[tool] Write" "$TMP/a-out.log"; then
    pass "A-3: una linea '[tool] <nombre>' por cada tool_use (Read y Write)"
else
    fail "A-3: no se encontraron las lineas de tool call esperadas: $(cat "$TMP/a-out.log")"
fi

if grep -q '"type"' "$TMP/a-out.log"; then
    fail "A-4: quedo JSON crudo visible en el log derivado"
else
    pass "A-4: el log derivado es texto legible, sin JSON crudo"
fi

ORDER_OK=$(awk '/Voy a leer/{a=NR} /\[tool\] Read/{b=NR} /\[tool\] Write/{c=NR} /Listo, hice el cambio/{d=NR} END{print (a<b && b<c && c<d) ? "si" : "no"}' "$TMP/a-out.log")
if [ "$ORDER_OK" = "si" ]; then
    pass "A-5: el orden del log derivado respeta el orden del stream"
else
    fail "A-5: el orden del log derivado no respeta el orden del stream"
fi

# -------- Bloque B: stream truncado a mitad de linea --------

echo ""
echo "[B] Stream truncado a mitad de linea -> se ignora sin abortar, no se pierde texto previo"

printf '{"type":"assistant","message":{"content":[{"type":"text","text":"primera linea completa"}]}}\n{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_9","name":"Bash","input":{"command":"ls' > "$TMP/b-stream.jsonl"
: > "$TMP/b-stderr.log"

(
    set -euo pipefail
    derive_stage_log_from_stream "$TMP/b-stream.jsonl" "$TMP/b-stderr.log" "$TMP/b-out.log"
)
RC=$?

if [ "$RC" -eq 0 ]; then
    pass "B-1: un stream truncado no aborta el pipeline (set -euo pipefail activo)"
else
    fail "B-1: se esperaba exit 0 bajo set -euo pipefail, se obtuvo $RC"
fi

if grep -qF "primera linea completa" "$TMP/b-out.log"; then
    pass "B-2: el texto de la linea completa anterior a la truncada no se pierde"
else
    fail "B-2: se perdio el texto de la linea completa: $(cat "$TMP/b-out.log" 2>/dev/null)"
fi

if grep -qF "toolu_9" "$TMP/b-out.log"; then
    fail "B-3: la linea truncada (JSON invalido) no deberia haberse colado en el log"
else
    pass "B-3: la linea truncada se ignoro (no aparece en el log derivado)"
fi

# -------- Bloque C: traza vacia --------

echo ""
echo "[C] Traza vacia (stream vacio, sin stderr) -> no falla, log derivado vacio"

: > "$TMP/c-stream.jsonl"
: > "$TMP/c-stderr.log"

(
    set -euo pipefail
    derive_stage_log_from_stream "$TMP/c-stream.jsonl" "$TMP/c-stderr.log" "$TMP/c-out.log"
)
RC=$?

if [ "$RC" -eq 0 ]; then
    pass "C-1: traza vacia no aborta el pipeline"
else
    fail "C-1: se esperaba exit 0 con traza vacia, se obtuvo $RC"
fi

if [ -f "$TMP/c-out.log" ] && [ ! -s "$TMP/c-out.log" ]; then
    pass "C-2: el log derivado existe y queda vacio (nada que perder)"
else
    fail "C-2: el log derivado deberia existir y estar vacio: $(cat "$TMP/c-out.log" 2>/dev/null)"
fi

# -------- Bloque D: .stderr.log con errores del CLI llega al log derivado --------

echo ""
echo "[D] .stderr.log con errores del CLI -> el texto llega al log derivado, donde run_agent clasifica"

: > "$TMP/d-stream.jsonl"

echo "API Error: 500 Internal Server Error" > "$TMP/d-stderr-5xx.log"
derive_stage_log_from_stream "$TMP/d-stream.jsonl" "$TMP/d-stderr-5xx.log" "$TMP/d-out-5xx.log"
if grep -q "API Error: 5" "$TMP/d-out-5xx.log"; then
    pass "D-1: 'API Error: 500' del .stderr.log llega al log derivado (mismo grep con que classify_agent_failure emite PROVIDER_UNAVAILABLE)"
else
    fail "D-1: no se encontro 'API Error: 5' en el log derivado: $(cat "$TMP/d-out-5xx.log")"
fi

echo "API Error: 400 Bad Request" > "$TMP/d-stderr-4xx.log"
derive_stage_log_from_stream "$TMP/d-stream.jsonl" "$TMP/d-stderr-4xx.log" "$TMP/d-out-4xx.log"
if grep -q "API Error: 4" "$TMP/d-out-4xx.log"; then
    pass "D-2: 'API Error: 400' del .stderr.log llega al log derivado (mismo grep con que classify_agent_failure emite API_ERROR_CLIENT)"
else
    fail "D-2: no se encontro 'API Error: 4' en el log derivado: $(cat "$TMP/d-out-4xx.log")"
fi

# -------- Bloque E: jq ausente -> degrada con gracia --------

echo ""
echo "[E] jq ausente -> degrada con gracia, no aborta, igual anexa el stderr (CA-4)"

E_PATH_SIN_JQ="$TMP/bin-sin-jq"
mkdir -p "$E_PATH_SIN_JQ"
# PATH de un solo directorio, poblado a mano con los binarios que la funcion SI
# necesita (`cat`) y sin jq. Apuntar a un directorio real del sistema (/bin,
# /usr/bin) haria que el caso dependiera de donde esta instalado jq en la
# maquina que corre el test: con jq en /usr/bin aqui y en /bin alla, el bloque
# pasaria sin ejercer la rama sin-jq y nadie se enteraria.
ln -sf "$(command -v cat)" "$E_PATH_SIN_JQ/cat"
echo "API Error: 500 sin jq" > "$TMP/e-stderr.log"
cat > "$TMP/e-stream.jsonl" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"esto no se deberia parsear sin jq"}]}}
EOF

(
    set -euo pipefail
    PATH="$E_PATH_SIN_JQ"
    command -v jq >/dev/null 2>&1 && { echo "PRECONDICION ROTA: jq sigue en PATH" >&2; exit 99; }
    derive_stage_log_from_stream "$TMP/e-stream.jsonl" "$TMP/e-stderr.log" "$TMP/e-out.log"
)
RC=$?

if [ "$RC" -eq 0 ]; then
    pass "E-1: sin jq en PATH, la funcion no aborta el pipeline"
else
    fail "E-1: se esperaba exit 0 sin jq, se obtuvo $RC"
fi

if [ -s "$TMP/e-out.log" ] && ! grep -q '"type"' "$TMP/e-out.log"; then
    pass "E-2: sin jq, el log derivado queda con una nota legible (no JSON crudo)"
else
    fail "E-2: el log derivado sin jq no es el esperado: $(cat "$TMP/e-out.log" 2>/dev/null)"
fi

if grep -qF "API Error: 500 sin jq" "$TMP/e-out.log"; then
    pass "E-3: sin jq, el .stderr.log de todos modos se anexa al log derivado"
else
    fail "E-3: sin jq, no se anexo el stderr al log derivado"
fi

# -------- Bloque G: el evento result con is_error llega al log derivado --------

echo ""
echo "[G] Evento 'result' con is_error y stderr vacio -> el error igual se clasifica"

# Forma real capturada del CLI en una corrida fallida: subtype "success" pero
# is_error true, el status en api_error_status y el texto en .result -- y
# stderr sin una sola linea de error.
cat > "$TMP/g-stream-5xx.jsonl" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"Empiezo a trabajar."}]}}
{"type":"result","is_error":true,"terminal_reason":"api_error","api_error_status":500,"subtype":"success","result":"Overloaded","num_turns":3,"duration_ms":90000}
EOF
: > "$TMP/g-stderr-vacio.log"

derive_stage_log_from_stream "$TMP/g-stream-5xx.jsonl" "$TMP/g-stderr-vacio.log" "$TMP/g-out-5xx.log"

if grep -q "API Error: 5" "$TMP/g-out-5xx.log"; then
    pass "G-1: un 5xx reportado SOLO en el evento result se clasifica PROVIDER_UNAVAILABLE (mismo grep de classify_agent_failure)"
else
    fail "G-1: el 5xx del evento result no llego al log derivado: $(cat "$TMP/g-out-5xx.log")"
fi

if grep -qF "Empiezo a trabajar." "$TMP/g-out-5xx.log"; then
    pass "G-2: el texto del asistente previo al fallo se conserva"
else
    fail "G-2: se perdio el texto del asistente"
fi

cat > "$TMP/g-stream-4xx.jsonl" <<'EOF'
{"type":"result","is_error":true,"terminal_reason":"api_error","api_error_status":404,"subtype":"success","result":"There's an issue with the selected model."}
EOF
derive_stage_log_from_stream "$TMP/g-stream-4xx.jsonl" "$TMP/g-stderr-vacio.log" "$TMP/g-out-4xx.log"
if grep -q "API Error: 4" "$TMP/g-out-4xx.log"; then
    pass "G-3: un 4xx del evento result se clasifica API_ERROR_CLIENT"
else
    fail "G-3: el 4xx del evento result no llego al log derivado: $(cat "$TMP/g-out-4xx.log")"
fi

# Caso negativo: una corrida sana no debe dejar rastro del result en el log --
# si lo dejara, un `result` cualquiera podria disparar los grep de fallo.
cat > "$TMP/g-stream-ok.jsonl" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"Listo."}]}}
{"type":"result","is_error":false,"subtype":"success","result":"ok","num_turns":2,"duration_ms":3490,"duration_api_ms":1727}
EOF
derive_stage_log_from_stream "$TMP/g-stream-ok.jsonl" "$TMP/g-stderr-vacio.log" "$TMP/g-out-ok.log"
if [ "$(cat "$TMP/g-out-ok.log")" = "Listo." ]; then
    pass "G-4: un result sin error no agrega nada al log derivado (no introduce falsos positivos)"
else
    fail "G-4: el result de una corrida sana ensucio el log: $(cat "$TMP/g-out-ok.log")"
fi

# Linea de JSON valido pero no-objeto: `.type` sobre un string es un error duro
# de jq que `fromjson?` NO atrapa -- el select(type=="object") es lo que evita
# que una sola linea rara contamine la derivacion de todo el stage.
printf '"una linea suelta"\n{"type":"assistant","message":{"content":[{"type":"text","text":"texto posterior"}]}}\n' > "$TMP/g-stream-raro.jsonl"
(
    set -euo pipefail
    derive_stage_log_from_stream "$TMP/g-stream-raro.jsonl" "$TMP/g-stderr-vacio.log" "$TMP/g-out-raro.log"
) 2>"$TMP/g-raro.stderr"
RC=$?

if [ "$RC" -eq 0 ] && grep -qF "texto posterior" "$TMP/g-out-raro.log"; then
    pass "G-5: una linea de JSON valido pero no-objeto no aborta ni corta la derivacion del resto"
else
    fail "G-5: la linea no-objeto rompio la derivacion (rc=$RC): $(cat "$TMP/g-out-raro.log" 2>/dev/null)"
fi

if [ ! -s "$TMP/g-raro.stderr" ]; then
    pass "G-6: la derivacion no escupe ruido de jq por stderr"
else
    fail "G-6: jq dejo ruido por stderr: $(cat "$TMP/g-raro.stderr")"
fi

# --- [H] tdd/iac/scaffold consumen el JSONL neutral (issue #1624: iac se
# sumo; issue #1644: scaffold se sumo). tooling-pipeline.mts lo cubre en
# tooling-pipeline.test.mts ---
echo ""
echo "[H] derivacion de logs por frontera de ejecucion"
for p in tdd-pipeline.sh iac-pipeline.sh scaffold-pipeline.sh; do
    if grep -q 'mefisto-run-agent.sh' "$REPO_ROOT/scripts/$p" \
        && grep -q 'derive_stage_log_from_stream "$events_file"' "$REPO_ROOT/scripts/$p" \
        && ! grep -q -- '--output-format' "$REPO_ROOT/scripts/$p"; then
        pass "H: $p deriva run_agent desde el JSONL neutral"
    else
        fail "H: $p no respeta la frontera neutral"
    fi
done

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
