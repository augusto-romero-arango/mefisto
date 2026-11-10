#!/usr/bin/env bash
# test-run-agent-telemetry.sh -- Tests de la telemetria de herramientas que
# mefisto-run-agent.sh emite a `--events-log` (issue #863, MEF-ADR-0049).
#
# Cubre:
#   [pre] El runner existe y tiene sintaxis bash valida.
#   [A] CA-1: formato de linea -- `[HH:MM:SS][tool] <agente> <tool>
#       <ok|fail> <ruta-o-resumen|->` por cada tool.completed, `[HH:MM:SS]
#       [archivo] <ruta>` por cada tool.started con input_summary no nulo, y
#       `[HH:MM:SS][stage] <agente> <status>` en el terminal. Ejercido contra
#       el adaptador fake (runtime-fake.sh, #858) para no depender de un CLI
#       real. Sin `--events-log` no deriva ni escribe una ruta de estado.
#   [B] CA-1/CA-2: contra el fixture REAL de Claude Code
#       (fixtures/runtime-claude/success.jsonl, tool Read con
#       input.file_path:"x") -- el runner completo (stub `claude` en el PATH)
#       produce `[archivo] x` y `[tool] <agente> Read ok x`.
#   [B2] CA-1: un `tool.started` de `Bash` (input_summary = comando, no ruta)
#       produce la "ruta-o-resumen" de la linea `[tool]` pero NUNCA una linea
#       `[archivo]` -- ese tag lo lee work-status-collect.sh como actividad de
#       archivos.
#   [D] CA-3: `--events-log` bajo un directorio sin permisos de escritura
#       degrada a un aviso en stderr, sin alterar el exit code del runner ni
#       el evento terminal ya escrito en `--event-log`.
#   [E] CA-6: el runner no lee contenido de archivos, variables de
#       credenciales ni auth stores para producir la telemetria (grep sobre
#       el propio script).
#
# Uso: .claude/scripts/tests/test-run-agent-telemetry.sh
# Exit code: 0 si todos los checks pasan, 1 si alguno falla.
# Bash 3.2 + jq 1.7 (MEF-ADR-0049 CA-6): sin arrays asociativos.

set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNNER="$REPO_ROOT/src/runtime/mefisto-run-agent.sh"
CLAUDE_FIXTURES="$SCRIPT_DIR/fixtures/runtime-claude"

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

# Formatos de linea esperados (CA-1): HH:MM:SS entre corchetes, seguido del
# tag del tipo de evento.
RE_TOOL='^\[[0-2][0-9]:[0-5][0-9]:[0-5][0-9]\]\[tool\] [^ ]+ [^ ]+ (ok|fail) .+$'
RE_ARCHIVO='^\[[0-2][0-9]:[0-5][0-9]:[0-5][0-9]\]\[archivo\] .+$'
RE_STAGE='^\[[0-2][0-9]:[0-5][0-9]:[0-5][0-9]\]\[stage\] [^ ]+ (success|failed|timeout|protocol_invalid)$'

echo "[pre] El runner existe y tiene sintaxis valida"
if [ -f "$RUNNER" ]; then
    pass "mefisto-run-agent.sh presente"
else
    fail "mefisto-run-agent.sh no existe"
    echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
    exit 1
fi

if bash -n "$RUNNER" 2>/dev/null; then
    pass "sintaxis bash valida"
else
    fail "sintaxis bash invalida"
fi

# ============================================================================
echo ""
echo "[A] CA-1: formato de linea contra el adaptador fake, con y sin --events-log explicito"

EV_A1_JSONL="$TMP/a1-event.jsonl"
EV_A1_LOG="$TMP/a1-events.log"
RC=$(MEFISTO_FAKE_SCRIPT=success "$RUNNER" --runtime fake --agent fx-agent \
    --cwd "$WORKDIR" --prompt-file "$PROMPT_FILE" --event-log "$EV_A1_JSONL" \
    --events-log "$EV_A1_LOG" >/dev/null 2>&1; echo $?)
if [ "$RC" = "0" ]; then
    pass "A-1: exit 0 con --events-log explicito"
else
    fail "A-1: exit $RC (esperaba 0)"
fi

if [ -f "$EV_A1_LOG" ] && grep -Eq "$RE_TOOL" "$EV_A1_LOG"; then
    pass "A-2: linea [tool] con el formato '[HH:MM:SS][tool] <agente> <tool> <ok|fail> <ruta-o-resumen>'"
else
    fail "A-2: no se encontro una linea [tool] con el formato esperado. Contenido: $(cat "$EV_A1_LOG" 2>/dev/null)"
fi

if grep -Eq "$RE_STAGE" "$EV_A1_LOG" && grep -q '\[stage\] fx-agent success' "$EV_A1_LOG"; then
    pass "A-3: linea [stage] final con el agente y el status del terminal"
else
    fail "A-3: no se encontro la linea [stage] esperada. Contenido: $(cat "$EV_A1_LOG" 2>/dev/null)"
fi

# El adaptador fake nunca puebla input_summary (runtime-fake.sh): la
# ruta-o-resumen del tool.completed tiene que caer en "-", nunca inventarse.
if grep -q '\[tool\] fx-agent demo ok -' "$EV_A1_LOG"; then
    pass "A-4: ruta-o-resumen ausente se escribe como '-' (CA-2), nunca inventada"
else
    fail "A-4: se esperaba '... demo ok -'. Contenido: $(cat "$EV_A1_LOG" 2>/dev/null)"
fi

# Sin --events-log no hay destino implicito: el nucleo neutral no deriva rutas
# de estado (contrato vigente desde la migracion a src/runtime/).
STATE_DIR="$TMP/state/.mefisto/pipeline"
EV_A5_JSONL="$TMP/a5-event.jsonl"
RC=$(MEFISTO_FAKE_SCRIPT=success MEFISTO_STATE_DIR="$STATE_DIR" "$RUNNER" \
    --runtime fake --agent fx-agent --cwd "$WORKDIR" --prompt-file "$PROMPT_FILE" \
    --event-log "$EV_A5_JSONL" >/dev/null 2>&1; echo $?)
if [ "$RC" = "0" ] && [ ! -e "$STATE_DIR/events.log" ]; then
    pass "A-5: sin --events-log no se deriva ningun destino de telemetria humana"
else
    fail "A-5: exit $RC o se escribio un events.log implicito fuera del contrato neutral"
fi

# ============================================================================
echo ""
echo "[B] CA-1/CA-2: fixture REAL de Claude Code (tool_use Read con file_path:'x')"

B_STUB_BIN="$TMP/bin-claude"
mkdir -p "$B_STUB_BIN"
cat > "$B_STUB_BIN/claude" <<STUBEOF
#!/bin/sh
cat "$CLAUDE_FIXTURES/success.jsonl"
exit 0
STUBEOF
chmod +x "$B_STUB_BIN/claude"

ORIG_PATH="$PATH"
EV_B_JSONL="$TMP/b-event.jsonl"
EV_B_LOG="$TMP/b-events.log"
PATH="$B_STUB_BIN:$ORIG_PATH"
RC=$("$RUNNER" --runtime claude --agent writer \
    --cwd "$WORKDIR" --prompt-file "$PROMPT_FILE" --event-log "$EV_B_JSONL" \
    --events-log "$EV_B_LOG" >/dev/null 2>&1; echo $?)
PATH="$ORIG_PATH"

if grep -Eq "$RE_ARCHIVO" "$EV_B_LOG" && grep -q '\[archivo\] x' "$EV_B_LOG"; then
    pass "B-1: tool.started de un tool de archivo (Read) produce '[archivo] x'"
else
    fail "B-1: no se encontro '[archivo] x'. Contenido: $(cat "$EV_B_LOG" 2>/dev/null)"
fi

if grep -q '\[tool\] writer Read ok x' "$EV_B_LOG"; then
    pass "B-2: tool.completed de Read arrastra la ruta 'x' del tool_use emparejado"
else
    fail "B-2: no se encontro '... writer Read ok x'. Contenido: $(cat "$EV_B_LOG" 2>/dev/null)"
fi

if grep -Eq "$RE_STAGE" "$EV_B_LOG"; then
    pass "B-3: linea [stage] final presente"
else
    fail "B-3: no se encontro la linea [stage]. Contenido: $(cat "$EV_B_LOG" 2>/dev/null)"
fi

# ============================================================================
echo ""
echo "[B2] CA-1: un tool.started de Bash NO produce linea [archivo] (su input_summary es un comando, no una ruta)"

# Fixture inline (no congelado en fixtures/: no captura una version de ningun
# CLI, solo reordena los mismos bloques que success.jsonl con un tool `Bash`).
# `Bash` SI lleva input_summary -- los primeros 80 caracteres del comando, ver
# "Notas tecnicas" de #863 -- asi que alimenta la "ruta-o-resumen" de la linea
# [tool]; pero un comando no es una ruta y work-status-collect.sh lee
# `[archivo]` como actividad de archivos, de modo que esa linea NO debe salir.
B2_FIXTURE="$TMP/b2-bash.jsonl"
cat > "$B2_FIXTURE" <<'FIXEOF'
{"type":"system","subtype":"init","session_id":"sess-b2","model":"claude-sonnet-5"}
{"type":"assistant","timestamp":"2026-07-27T22:09:34.500Z","message":{"content":[{"type":"tool_use","id":"toolu_b2","name":"Bash","input":{"command":"git status -sb"}}]}}
{"type":"user","timestamp":"2026-07-27T22:09:34.700Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_b2","content":"## main"}]}}
{"type":"result","is_error":false,"subtype":"success","stop_reason":"end_turn","num_turns":1,"duration_ms":1000,"duration_api_ms":800,"total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":5},"ttft_ms":100,"permission_denials":[],"timestamp":"2026-07-27T22:09:36.000Z"}
FIXEOF

B2_STUB_BIN="$TMP/bin-claude-b2"
mkdir -p "$B2_STUB_BIN"
cat > "$B2_STUB_BIN/claude" <<STUBEOF
#!/bin/sh
cat "$B2_FIXTURE"
exit 0
STUBEOF
chmod +x "$B2_STUB_BIN/claude"

EV_B2_JSONL="$TMP/b2-event.jsonl"
EV_B2_LOG="$TMP/b2-events.log"
PATH="$B2_STUB_BIN:$ORIG_PATH"
"$RUNNER" --runtime claude --agent writer \
    --cwd "$WORKDIR" --prompt-file "$PROMPT_FILE" --event-log "$EV_B2_JSONL" \
    --events-log "$EV_B2_LOG" >/dev/null 2>&1
PATH="$ORIG_PATH"

if ! grep -q '\[archivo\]' "$EV_B2_LOG"; then
    pass "B2-1: el tool.started de Bash no emitio ninguna linea [archivo]"
else
    fail "B2-1: se emitio una linea [archivo] para un comando. Contenido: $(cat "$EV_B2_LOG" 2>/dev/null)"
fi

if grep -q '\[tool\] writer Bash ok git status -sb' "$EV_B2_LOG"; then
    pass "B2-2: el comando si viaja como 'ruta-o-resumen' de la linea [tool]"
else
    fail "B2-2: no se encontro '... Bash ok git status -sb'. Contenido: $(cat "$EV_B2_LOG" 2>/dev/null)"
fi

# ============================================================================
echo ""
echo "[D] CA-3: --events-log bajo un directorio sin permisos degrada a un aviso, sin afectar exit/terminal"

D_BADDIR="$TMP/readonly"
mkdir -p "$D_BADDIR"
chmod 555 "$D_BADDIR"
EV_D_JSONL="$TMP/d-event.jsonl"
D_ERR="$TMP/d-stderr.txt"
RC=$(MEFISTO_FAKE_SCRIPT=success "$RUNNER" --runtime fake --agent fx-agent \
    --cwd "$WORKDIR" --prompt-file "$PROMPT_FILE" --event-log "$EV_D_JSONL" \
    --events-log "$D_BADDIR/sub/events.log" 2>"$D_ERR" >/dev/null; echo $?)
chmod 755 "$D_BADDIR"

if [ "$RC" = "0" ]; then
    pass "D-1: exit code de la corrida NO se altera pese al fallo de escritura"
else
    fail "D-1: exit $RC (esperaba 0, igual que sin --events-log)"
fi

if [ -s "$EV_D_JSONL" ] && jq -e 'select(.type=="run.completed" or .type=="run.failed")' "$EV_D_JSONL" >/dev/null 2>&1; then
    pass "D-2: el evento terminal de --event-log sigue escrito con normalidad"
else
    fail "D-2: --event-log no tiene el evento terminal esperado"
fi

if grep -qi "AVISO" "$D_ERR"; then
    pass "D-3: el fallo de escritura degrada a un aviso en stderr"
else
    fail "D-3: no se encontro un aviso en stderr. Contenido: $(cat "$D_ERR" 2>/dev/null)"
fi

# ============================================================================
echo ""
echo "[E] CA-6: el runner no lee contenido de archivos ni credenciales para la telemetria"

# La telemetria solo puede derivarse de los campos del JSONL neutral (ts,
# tool, input_summary, ok, status) -- nunca de una lectura de archivo, una
# variable de credenciales o un auth store.
FORBIDDEN_PATTERNS=(
    "ANTHROPIC_API_KEY"
    "OPENAI_API_KEY"
    "auth\\.json"
    "\\.aws/"
    "\\.ssh/"
)
CLEAN=true
for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    if grep -Eq "$pattern" "$RUNNER"; then
        CLEAN=false
        fail "E-1: el runner menciona un patron prohibido: $pattern"
    fi
done
if [ "$CLEAN" = "true" ]; then
    pass "E-1: ninguna variable de credenciales ni ruta de auth store aparece en el runner"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
