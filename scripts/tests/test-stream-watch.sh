#!/usr/bin/env bash
# Tests focalizados del visor run-events.v1. No invocan runtimes ni escriben
# estado del consumidor: todo el estado simulado vive bajo un mktemp.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET="$REPO_ROOT/scripts/stream-watch.sh"
PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
assert_contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3 -- falta '$2' en: $1" ;; esac; }
assert_absent() { case "$1" in *"$2"*) fail "$3 -- aparecio '$2'" ;; *) pass "$3" ;; esac; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq requerido" >&2; exit 1; }
TMP=$(mktemp -d "${TMPDIR:-/tmp}/test-stream-watch.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

[ -x "$TARGET" ] && pass "el visor publicado es ejecutable" || fail "el visor publicado no es ejecutable"
mkdir -p "$TMP/consumidor"
git init -q "$TMP/consumidor" || exit 1
HELP=$(cd "$TMP/consumidor" && "$TARGET" --help) || {
    fail "la invocacion directa del visor devuelve 0"
    HELP=""
}
assert_contains "$HELP" "Uso: stream-watch.sh" "la invocacion directa muestra el uso esperado"

# Sourcing define funciones y solo carga el helper; no dispara el main.
source "$TARGET"
RED=""; YELLOW=""; BLUE=""; CYAN=""; BOLD=""; NC=""
MEFISTO_STATE_DIR="$TMP/consumidor con espacios/.mefisto/pipeline"
MEFISTO_LEGACY_STATE_DIR="$TMP/consumidor con espacios/.claude/pipeline"
mkdir -p "$MEFISTO_STATE_DIR/logs" "$MEFISTO_LEGACY_STATE_DIR/logs" "$TMP/visor"
TMP_STATE="$TMP/visor"

reset_viewer() {
    ISSUES_CSV=""; NEWER_THAN=""; LAST_LINE=0; PREV_EMS=""
    CURRENT_STREAM=""; CURRENT_FORMAT=""; RUN_RUNTIME=""; RUN_AGENT=""; RUN_MODEL=""; TERMINAL_COUNT=0
}

render_file() {
    local stream="$1" out="$2"
    reset_viewer
    activate_stream "$stream" > "$out"
    process_new_lines "$stream" >> "$out"
}

echo "[A] Protocolo neutral y redaccion"
CLAUDE="$MEFISTO_STATE_DIR/logs/tooling-stage-1-writer-20260908-100000-issue-1123.events.jsonl"
cp "$SCRIPT_DIR/fixtures/stream-watch/neutral-claude.events.jsonl" "$CLAUDE"
cat "$SCRIPT_DIR/fixtures/stream-watch/neutral-sensitive-unknown.events.jsonl" >> "$CLAUDE"
render_file "$CLAUDE" "$TMP/claude.out"
OUT=$(<"$TMP/claude.out")
assert_contains "$OUT" "neutral | issue #1123 | stage 1 | runtime claude | agente writer | modelo modelo-claude" "encabezado neutral completo"
assert_contains "$OUT" "mensaje (text)" "renderiza tipo de mensaje sin su texto"
assert_contains "$OUT" "herramienta Bash iniciada" "renderiza tool.started sin input"
assert_contains "$OUT" "herramienta Bash: ok (1.0s)" "renderiza tool.completed"
assert_contains "$OUT" "desenlace run.completed | resultado=success | runtime=claude | agente=writer | modelo=modelo-claude | duracion=4.0s" "renderiza el unico terminal"
for secret in SECRETO-no-mostrar input_summary prompt Authorization Bearer tokens headers cwd /tmp; do
    assert_absent "$OUT" "$secret" "no filtra al pane: $secret"
done
[ "$TERMINAL_COUNT" -eq 1 ] && pass "cuenta exactamente un terminal" || fail "terminales=$TERMINAL_COUNT"

FAILED="$MEFISTO_STATE_DIR/logs/tooling-stage-2-reviewer-20260908-110000-issue-1124.events.jsonl"
cp "$SCRIPT_DIR/fixtures/stream-watch/neutral-failed.events.jsonl" "$FAILED"
render_file "$FAILED" "$TMP/failed.out"
OUT=$(<"$TMP/failed.out")
assert_contains "$OUT" "runtime fake | agente reviewer" "encabezado neutral de otro runtime"
assert_contains "$OUT" "resultado=failed" "renderiza terminal fallido"
assert_contains "$OUT" "La corrida no termino con exito" "un fallo no aparenta exito"
assert_absent "$OUT" "SECRETO-no-mostrar" "omite error.detail"

echo "[B] Parciales, corrupcion, truncado y cardinalidad"
PARTIAL="$TMP/partial.events.jsonl"
printf '%s' '{"v":1,"type":"message"' > "$PARTIAL"
reset_viewer; JQ_FILTER_PATH="$TMP/visor/filter.jq"; write_jq_filter "$JQ_FILTER_PATH" neutral
process_new_lines "$PARTIAL" > "$TMP/partial.out"
[ "$LAST_LINE" -eq 0 ] && pass "la parcial no avanza el cursor" || fail "la parcial avanzo a $LAST_LINE"
assert_contains "$(<"$TMP/partial.out")" "linea parcial" "degradacion parcial visible"
printf '%s\n' ',"ts":"2026-09-08T10:00:00Z","role":"assistant","text":"oculto"}' >> "$PARTIAL"
process_new_lines "$PARTIAL" > "$TMP/repaired.out"
[ "$LAST_LINE" -eq 1 ] && pass "la linea reparada se consume" || fail "cursor reparado=$LAST_LINE"

CORRUPT="$TMP/corrupt.events.jsonl"
printf '%s\n' '{corrupta}' '{"v":1,"type":"message","ts":"2026-09-08T10:00:00Z","role":"assistant","text":"SECRETO-no-mostrar"}' > "$CORRUPT"
reset_viewer; JQ_FILTER_PATH="$TMP/visor/filter.jq"; write_jq_filter "$JQ_FILTER_PATH" neutral
process_new_lines "$CORRUPT" > "$TMP/corrupt.out"
[ "$LAST_LINE" -eq 2 ] && pass "omite corrupta y continua" || fail "cursor corrupto=$LAST_LINE"
assert_contains "$(<"$TMP/corrupt.out")" "linea corrupta omitida" "degradacion corrupta visible"
assert_absent "$(<"$TMP/corrupt.out")" "SECRETO-no-mostrar" "corrupcion no desactiva redaccion"

TRUNCATED="$TMP/truncated.events.jsonl"
printf '%s\n' '{"v":1,"type":"run.started","ts":"2026-09-08T10:00:00Z","runtime":"claude","agent":"writer","model":null,"cwd":"/tmp"}' > "$TRUNCATED"
reset_viewer; activate_stream "$TRUNCATED" >/dev/null; process_new_lines "$TRUNCATED" >/dev/null
CURRENT_STREAM="$TRUNCATED"; CURRENT_FORMAT=neutral
finish_current_stream > "$TMP/truncated.out"
assert_contains "$(<"$TMP/truncated.out")" "quedo truncado" "stream sin terminal degrada visiblemente"
assert_absent "$(<"$TMP/truncated.out")" "exito" "stream truncado no aparenta exito"

DUP="$TMP/duplicate.events.jsonl"
cp "$SCRIPT_DIR/fixtures/stream-watch/neutral-claude.events.jsonl" "$DUP"
printf '%s\n' "$(sed -n '$p' "$SCRIPT_DIR/fixtures/stream-watch/neutral-claude.events.jsonl")" >> "$DUP"
render_file "$DUP" "$TMP/duplicate.out"
[ "$(grep -c 'desenlace run.completed' "$TMP/duplicate.out")" -eq 1 ] && pass "solo renderiza un terminal" || fail "renderizo terminal duplicado"
assert_contains "$(<"$TMP/duplicate.out")" "mas de un terminal" "cardinalidad invalida visible"

echo "[C] Descubrimiento, roots, preferencia, filtros y rotacion"
reset_viewer
# Canonico gana aunque legacy tenga un mtime posterior.
LEGACY_NEW="$MEFISTO_LEGACY_STATE_DIR/logs/iac-stage-9-reviewer-20260908-120000-issue-1125.stream.jsonl"
cp "$SCRIPT_DIR/fixtures/stream-watch/legacy-claude.stream.jsonl" "$LEGACY_NEW"
touch -t 202609081200 "$LEGACY_NEW"
touch -t 202609081000 "$CLAUDE"
FOUND=$(discover_stream)
[ "$FOUND" = "$FAILED" ] || [ "$FOUND" = "$CLAUDE" ] && pass "consulta root canonico antes que legacy" || fail "descubrio $FOUND"

# Sin canonico, un neutral legacy emparejado gana al Claude del mismo stem.
rm "$MEFISTO_STATE_DIR/logs"/*.events.jsonl
PAIR_STEM="$MEFISTO_LEGACY_STATE_DIR/logs/tooling-stage-3-writer-20260908-130000-issue-1126"
cp "$SCRIPT_DIR/fixtures/stream-watch/legacy-claude.stream.jsonl" "$PAIR_STEM.stream.jsonl"
cp "$SCRIPT_DIR/fixtures/stream-watch/neutral-claude.events.jsonl" "$PAIR_STEM.events.jsonl"
FOUND=$(discover_stream)
[ "$FOUND" = "$PAIR_STEM.events.jsonl" ] && pass "neutral gana frente al Claude correspondiente" || fail "descubrio $FOUND"
rm "$PAIR_STEM.events.jsonl"
FOUND=$(discover_stream)
[ "$FOUND" = "$PAIR_STEM.stream.jsonl" ] && pass "fallback historico sin neutral" || fail "fallback=$FOUND"
render_file "$FOUND" "$TMP/legacy.out"
assert_contains "$(<"$TMP/legacy.out")" "legacy Claude" "fallback queda rotulado"

ISSUES_CSV=1125
FOUND=$(discover_stream)
[ "$FOUND" = "$LEGACY_NEW" ] && pass "--issues selecciona coincidencia exacta" || fail "filtro issue=$FOUND"
stream_matches_issues "stage-1-a-issue-1123.events.jsonl" 1123 && ! stream_matches_issues "stage-1-a-issue-11230.events.jsonl" 1123 && pass "issue 1123 no confunde 11230" || fail "match de issue no exacto"
ISSUES_CSV=""; NEWER_THAN=9999999999
[ -z "$(discover_stream)" ] && pass "--newer-than excluye corridas viejas" || fail "newer-than encontro stream"
NEWER_THAN=""

# El cambio automatico resetea cursor/metadata y denuncia el anterior truncado.
reset_viewer
activate_stream "$TRUNCATED" >/dev/null; process_new_lines "$TRUNCATED" >/dev/null
activate_stream "$PAIR_STEM.stream.jsonl" > "$TMP/rotation.out"
assert_contains "$(<"$TMP/rotation.out")" "stream anterior quedo truncado" "rotacion denuncia stream sin terminal"
[ "$LAST_LINE" -eq 0 ] && [ "$CURRENT_FORMAT" = legacy-claude ] && pass "rotacion resetea estado y formato" || fail "rotacion no reseteo"

echo "[D] Ruta manual, paths con espacios y solo lectura"
MANUAL="$TMP/ruta manual con espacios.events.jsonl"
cp "$SCRIPT_DIR/fixtures/stream-watch/neutral-failed.events.jsonl" "$MANUAL"
BEFORE=$(shasum "$MANUAL" | cut -d' ' -f1)
render_file "$MANUAL" "$TMP/manual.out"
AFTER=$(shasum "$MANUAL" | cut -d' ' -f1)
[ "$BEFORE" = "$AFTER" ] && pass "ruta manual no modifica el stream" || fail "ruta manual modificada"
assert_contains "$(<"$TMP/manual.out")" "estado: manual | ruta: $MANUAL" "ruta manual con espacios en encabezado"
stream_format "$MANUAL" >/dev/null && ! stream_format "$TMP/desconocido.jsonl" >/dev/null && pass "ruta manual restringida a formatos conocidos" || fail "formato manual incorrecto"

echo "Resumen: $PASS pass, $FAIL fail"
[ "$FAIL" -eq 0 ]
