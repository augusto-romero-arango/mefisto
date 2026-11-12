#!/usr/bin/env bash
# test-agent-resume.sh -- Tests de la reanudacion de sesion truncada tras un
# hold en los pipelines publicados (issue #972).
#
# Contexto: hasta este issue, la sonda de hold (issue #971) reenviaba el
# prompt original completo del stage en cada reintento -- si el stage ya
# habia avanzado antes de tropezar con RATE_LIMIT/PROVIDER_UNAVAILABLE, ese
# progreso se pagaba dos veces. Este issue hace que la sonda continue
# (`-c`/`--continue`) la conversacion truncada del propio worktree en vez de
# repetir el stage desde cero -- atajo que evita capturar `session_id` (solo
# confiable con PIPELINE_CAPTURE_STREAM=true, MEF-ADR-0051): `-c` resuelve
# "la conversacion mas reciente del directorio actual" (`claude --help`), y
# cada `run_agent` ya hace `cd "$WORKTREE_PATH"` antes de invocar el CLI.
#
# La afirmacion de que "la mas reciente del directorio" resuelve la sesion
# correcta cuando dos agentes distintos corrieron en secuencia en el mismo
# worktree (CA-4, el riesgo real del atajo) se verifico A MANO con el CLI
# real, no se asume: dos sesiones consecutivas de `claude -p` en el mismo
# directorio (simulando dos agentes de un stage TDD), seguidas de un tercer
# `claude -c -p "cual era el numero secreto?"` en ese mismo directorio --
# la respuesta y el `session_id` correspondieron a la SEGUNDA sesion, nunca a
# la primera. Repetirlo en cada corrida de esta suite costaria una llamada
# real de API por chequeo (lento, no determinista, requiere red) -- lo que
# esta suite cubre en cambio es la mecanica de bash que decide CUANDO pasar
# `-c` y COMO degrada, con un `claude` fake que no golpea la red.
#
# Casos cubiertos:
#   [1] agent_resume_prompt: el texto menciona el stage/agente correctos, la
#       ruta exacta del resumen del stage, y la instruccion de continuar sin
#       reiniciar el analisis.
#   [6] Nunca se usa --fork-session en la sonda de ningun pipeline (notas
#       tecnicas del issue: reusar la sesion mantiene un solo transcript por
#       stage).
#
# Uso: scripts/tests/test-agent-resume.sh
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

echo "[1] agent_resume_prompt: contenido esperado"
PROMPT_TXT=$(agent_resume_prompt "2" "reviewer")
if echo "$PROMPT_TXT" | grep -q "stage 2, agente reviewer"; then
    pass "menciona el stage y el agente correctos"
else
    fail "no menciona 'stage 2, agente reviewer': $PROMPT_TXT"
fi
if echo "$PROMPT_TXT" | grep -qF ".claude/pipeline/summaries/stage-2-reviewer.md"; then
    pass "referencia la ruta exacta del resumen del stage"
else
    fail "no referencia .claude/pipeline/summaries/stage-2-reviewer.md"
fi
if echo "$PROMPT_TXT" | grep -qi "no reinicies tu analisis"; then
    pass "instruye continuar sin reiniciar el analisis"
else
    fail "no instruye continuar sin reiniciar el analisis"
fi
if echo "$PROMPT_TXT" | grep -q "gh pr create"; then
    pass "conserva la prohibicion de 'gh pr create'/'git push'"
else
    fail "no conserva la prohibicion de 'gh pr create'/'git push'"
fi
# Defensa en profundidad del aterrizaje equivocado: `-c` IGNORA en silencio
# `--agent` (verificado con el CLI real), asi que una reanudacion que caiga en
# una conversacion ajena correria sin la definicion del agente y con
# bypassPermissions -- el prompt tiene que ordenar cortar sin tocar archivos.
if echo "$PROMPT_TXT" | grep -q "SIN_SESION_PREVIA"; then
    pass "incluye el corte de seguridad si la reanudacion aterrizo en otra conversacion"
else
    fail "no incluye el corte de seguridad 'SIN_SESION_PREVIA'"
fi

echo ""
echo "[1b] agent_session_transcript_count: precondicion de -c"
CFG_DIR=$(mktemp -d)
WT_PROBE=$(mktemp -d)
_slug_for() {
    local real s
    real=$(cd "$1" && pwd -P)
    s="${real//\//-}"
    s="${s//./-}"
    printf '%s' "$s"
}
CFG_DIR_ORIG="${CLAUDE_CONFIG_DIR:-}"
export CLAUDE_CONFIG_DIR="$CFG_DIR"
if [ "$(agent_session_transcript_count "$WT_PROBE")" = "0" ]; then
    pass "sin store para el directorio -> 0 (fail-safe: no reanuda)"
else
    fail "sin store para el directorio deberia dar 0, dio $(agent_session_transcript_count "$WT_PROBE")"
fi
mkdir -p "$CFG_DIR/projects/$(_slug_for "$WT_PROBE")"
: > "$CFG_DIR/projects/$(_slug_for "$WT_PROBE")/aaa.jsonl"
: > "$CFG_DIR/projects/$(_slug_for "$WT_PROBE")/bbb.jsonl"
if [ "$(agent_session_transcript_count "$WT_PROBE")" = "2" ]; then
    pass "cuenta los transcripts del store del directorio (slug del path fisico)"
else
    fail "esperaba 2 transcripts, dio $(agent_session_transcript_count "$WT_PROBE")"
fi
if [ "$(agent_session_transcript_count "")" = "0" ]; then
    pass "directorio vacio como argumento -> 0"
else
    fail "directorio vacio como argumento deberia dar 0"
fi
if [ -n "$CFG_DIR_ORIG" ]; then export CLAUDE_CONFIG_DIR="$CFG_DIR_ORIG"; else unset CLAUDE_CONFIG_DIR; fi
rm -rf "$CFG_DIR" "$WT_PROBE"

echo ""
echo "[6] Ningun pipeline publicado usa --fork-session en la sonda de hold"
# Excluye lineas de comentario ('#'): _pipeline-common.sh documenta la
# decision de NO usar --fork-session en un comentario, que menciona el flag
# sin invocarlo.
FORK_HITS=$(grep -n "fork-session" "$REPO_ROOT"/scripts/*.sh 2>/dev/null | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)
if [ -z "$FORK_HITS" ]; then
    pass "cero invocaciones de --fork-session en scripts/*.sh (solo se documenta en comentarios)"
else
    fail "--fork-session invocado fuera de un comentario: $FORK_HITS"
fi

# La reanudacion por session_id de cada pipeline (primera sonda con
# --resume-session, degradacion permanente si la sesion reanudada vuelve a
# terminar sin el resumen del stage) la cubren sus tests en TypeScript
# (*-pipeline*.test.mts, pr-sync*.test.mts).

echo ""
echo "=== Resumen: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
