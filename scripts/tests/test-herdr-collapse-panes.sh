#!/usr/bin/env bash
# test-herdr-collapse-panes.sh -- Tests del modo --collapse-panes de
# scripts/herdr-pipeline.sh (issue #799: cerrar los paneles Herdr sobrantes
# de un lote --parallel al mergear con /merge, sin esperar al proximo
# despacho).
#
# Estilo test-herdr-parallel.sh: subproceso real con stubs de `herdr` en
# PATH que registran cada invocacion y devuelven respuestas deterministas
# por pane_id -- nunca tocan un servidor herdr ni la red.
#
# Cubre:
#   [A] (CA-3, CA-6) --collapse-panes poda el registro canonico (pane muerto
#       fuera), cierra los panes libres sobrantes del propio (workspace,runtime)
#       dejando el primero vivo, y no toca panes de otro runtime/workspace. No
#       despacha (sin pane split ni pane run). Comparte prune_report_panes
#       con acquire_report_pane (una sola implementacion, sin duplicar el
#       bucle).
#   [B] (CA-2) No-op seguro fuera de contexto: sin HERDR_ENV=1, o sin
#       PANES_STATE previo, o con runtime invalido, sale 0 imprimiendo "0"
#       sin invocar herdr ni mutar el pool.
#   [C] (CA-4) Chequeo estatico de la extraccion: prune_report_panes se
#       define una sola vez y la llaman los dos consumidores.
#
# Uso: scripts/tests/test-herdr-collapse-panes.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HERDR_SCRIPT="$REPO_ROOT/scripts/herdr-pipeline.sh"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

assert_contains() {
    local desc="$1" haystack="$2" needle="$3"
    if printf '%s' "$haystack" | grep -qF -- "$needle"; then
        pass "$desc"
    else
        fail "$desc -- no se encontro: '$needle'"
    fi
}

assert_not_contains() {
    local desc="$1" haystack="$2" needle="$3"
    if printf '%s' "$haystack" | grep -qF -- "$needle"; then
        fail "$desc -- se encontro indebidamente: '$needle'"
    else
        pass "$desc"
    fi
}

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        pass "$desc"
    else
        fail "$desc -- se esperaba '$expected', fue '$actual'"
    fi
}

extract_fn() {
    local name="$1" file="$2"
    awk -v fn="$name" '$0 ~ "^"fn"\\(\\) \\{" {p=1} p{print} p && /^}/{p=0}' "$file"
}

# --- [C] (CA-4) prune_report_panes: definida una vez y compartida ---
echo "[C] prune_report_panes: implementacion unica compartida por acquire_report_pane y cmd_collapse_panes"

DEF_COUNT=$(grep -c "^prune_report_panes() {" "$HERDR_SCRIPT")
assert_eq "prune_report_panes se define una sola vez" "1" "$DEF_COUNT"

ACQUIRE_BODY=$(extract_fn acquire_report_pane "$HERDR_SCRIPT")
assert_contains "acquire_report_pane llama a prune_report_panes" "$ACQUIRE_BODY" "prune_report_panes"

COLLAPSE_BODY=$(extract_fn cmd_collapse_panes "$HERDR_SCRIPT")
assert_contains "cmd_collapse_panes llama a prune_report_panes" "$COLLAPSE_BODY" "prune_report_panes"

# --- Entorno de subproceso: consumidor falso + stub de herdr ---
FAKE_CONSUMER="$(mktemp -d)"
TMP_DIR="$(mktemp -d)"
FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN"
trap 'rm -rf "$FAKE_CONSUMER" "$TMP_DIR"' EXIT

(cd "$FAKE_CONSUMER" && git init -q)

export HERDR_STUB_LOG="$TMP_DIR/herdr-invocations.log"

# Stub de herdr: registra cada invocacion y responde segun el pane_id.
#   pane get <id>            -> falla (pane muerto) si $id esta en HERDR_STUB_DEAD
#   pane process-info --pane <id> -> ocupado (fg != shell) si $id esta en
#                                     HERDR_STUB_OCCUPIED; libre en cualquier otro caso
#   pane close/split/run/rename -> ok
cat > "$FAKE_BIN/herdr" <<'STUB'
#!/usr/bin/env bash
set -u
echo "herdr $*" >> "$HERDR_STUB_LOG"
case "${1:-} ${2:-}" in
    "pane get")
        id="${3:-}"
        for d in ${HERDR_STUB_DEAD:-}; do
            [ "$d" = "$id" ] && exit 1
        done
        echo "{\"result\":{\"pane\":{\"pane_id\":\"$id\"}}}"
        ;;
    "pane process-info")
        id="${4:-}"
        for o in ${HERDR_STUB_OCCUPIED:-}; do
            if [ "$o" = "$id" ]; then
                echo '{"result":{"process_info":{"shell_pid":100,"foreground_process_group_id":200}}}'
                exit 0
            fi
        done
        echo '{"result":{"process_info":{"shell_pid":100,"foreground_process_group_id":100}}}'
        ;;
    *)
        echo '{"result":{"type":"ok"}}'
        ;;
esac
STUB
chmod +x "$FAKE_BIN/herdr"

PANES_STATE="$FAKE_CONSUMER/.mefisto/pipeline/herdr-report-panes.txt"
LEGACY_STATE="$FAKE_CONSUMER/.claude/pipeline/herdr-report-panes.txt"

# Limpia el contexto herdr heredado: si la suite corre dentro de un pane, el
# HERDR_ENV/HERDR_PANE_ID/HERDR_WORKSPACE_ID del padre se colaria al subproceso
# y los escenarios "fuera de herdr" entrarian al flujo herdr. Cada escenario
# repone por argumento las variables que necesita.
run_collapse() {
    : > "$HERDR_STUB_LOG"
    (
        cd "$FAKE_CONSUMER" || exit 99
        env -u MEFISTO_STATE_DIR -u MEFISTO_LEGACY_STATE_DIR \
            -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID "$@" \
            PATH="$FAKE_BIN:$PATH" \
            HERDR_STUB_LOG="$HERDR_STUB_LOG" \
            "$HERDR_SCRIPT" --collapse-panes 2>"$TMP_DIR/stderr.log"
    )
}

# --- [A] Poda y cierre selectivo (CA-1) ---
echo "[A] --collapse-panes: cierra solo libres sobrantes del mismo runtime"

mkdir -p "$(dirname "$PANES_STATE")"
mkdir -p "$(dirname "$LEGACY_STATE")"
printf '%s\n' "w1:legacy" > "$LEGACY_STATE"
LEGACY_BEFORE=$(shasum "$LEGACY_STATE")
printf '%s\n' \
    "w1:p1 claude" "w1:p2 claude" "w1:p3 claude" "w1:p4 fake" \
    "w1:p5 fake" "w1:p6 fake" "w1:p7 claude" "w2:p9 claude" > "$PANES_STATE"

OUT=$(run_collapse \
    HERDR_ENV=1 HERDR_PANE_ID=w1:p0 HERDR_WORKSPACE_ID=w1 \
    MEFISTO_RUNTIME=claude HERDR_STUB_DEAD="w1:p7" HERDR_STUB_OCCUPIED="w1:p3")
RC=$?
STUB_CALLS=$(cat "$HERDR_STUB_LOG")
FINAL_STATE=$(cat "$PANES_STATE")
LEGACY_AFTER=$(shasum "$LEGACY_STATE")

assert_eq "exit code 0" "0" "$RC"
assert_eq "stdout reporta 1 pane cerrado" "1" "$OUT"
assert_eq "exactamente 1 pane close" "1" "$(grep -c "^herdr pane close" <<< "$STUB_CALLS")"
assert_contains "cierra el libre sobrante w1:p2" "$STUB_CALLS" "pane close w1:p2"
assert_not_contains "no cierra el primer libre w1:p1 (queda vivo)" "$STUB_CALLS" "pane close w1:p1"
assert_not_contains "no cierra el ocupado w1:p3" "$STUB_CALLS" "pane close w1:p3"
assert_not_contains "no cierra pane libre de otro runtime w1:p5" "$STUB_CALLS" "pane close w1:p5"
assert_not_contains "no toca el pane de otro workspace w2:p9" "$STUB_CALLS" "pane close w2:p9"
assert_not_contains "no crea ningun pane (no despacha)" "$STUB_CALLS" "pane split"
assert_not_contains "no corre ningun pane run (no despacha)" "$STUB_CALLS" "pane run"
assert_contains "registro final conserva w1:p1 con runtime" "$FINAL_STATE" "w1:p1 claude"
assert_contains "registro final conserva w1:p3 ocupado" "$FINAL_STATE" "w1:p3 claude"
assert_contains "registro final conserva el otro runtime" "$FINAL_STATE" "w1:p5 fake"
assert_contains "registro final conserva w2:p9 (otro workspace)" "$FINAL_STATE" "w2:p9 claude"
assert_not_contains "registro final ya no tiene w1:p2 (cerrado)" "$FINAL_STATE" "w1:p2"
assert_not_contains "registro final ya no tiene w1:p7 (muerto, podado)" "$FINAL_STATE" "w1:p7"
assert_eq "pool legacy queda byte a byte intacto" "$LEGACY_BEFORE" "$LEGACY_AFTER"

# La misma poda debe funcionar al invertir la fila activa: p4 queda como libre
# reutilizable y p5/p6 convergen, sin cerrar panes de claude.
OUT=$(run_collapse \
    HERDR_ENV=1 HERDR_PANE_ID=w1:p0 HERDR_WORKSPACE_ID=w1 \
    MEFISTO_RUNTIME=fake)
RC=$?
STUB_CALLS=$(cat "$HERDR_STUB_LOG")
FINAL_STATE=$(cat "$PANES_STATE")
assert_eq "fake: exit code 0" "0" "$RC"
assert_eq "fake: cierra sus dos libres sobrantes" "2" "$OUT"
assert_contains "fake: cierra w1:p5" "$STUB_CALLS" "pane close w1:p5"
assert_contains "fake: cierra w1:p6" "$STUB_CALLS" "pane close w1:p6"
assert_not_contains "fake: no cierra pane de claude" "$STUB_CALLS" "pane close w1:p1"
assert_contains "fake: conserva un libre propio" "$FINAL_STATE" "w1:p4 fake"

# --- [B] No-op fuera de contexto (CA-2) ---
echo "[B] --collapse-panes: no-op seguro sin HERDR_ENV=1 o sin PANES_STATE previo"

printf '%s\n' "w1:p1 claude" "w1:p2 claude" > "$PANES_STATE"
OUT=$(run_collapse HERDR_PANE_ID=w1:p0 HERDR_WORKSPACE_ID=w1)
RC=$?
STUB_CALLS=$(cat "$HERDR_STUB_LOG")
assert_eq "sin HERDR_ENV=1: exit code 0" "0" "$RC"
assert_eq "sin HERDR_ENV=1: stdout '0'" "0" "$OUT"
assert_eq "sin HERDR_ENV=1: no invoca herdr" "0" "$(wc -l < "$HERDR_STUB_LOG" | tr -d ' ')"

POOL_BEFORE=$(shasum "$PANES_STATE")
OUT=$(run_collapse HERDR_ENV=1 HERDR_PANE_ID=w1:p0 HERDR_WORKSPACE_ID=w1 MEFISTO_RUNTIME=invalido)
RC=$?
POOL_AFTER=$(shasum "$PANES_STATE")
assert_eq "runtime invalido: exit code 0 best-effort" "0" "$RC"
assert_eq "runtime invalido: stdout '0'" "0" "$OUT"
assert_eq "runtime invalido: pool intacto" "$POOL_BEFORE" "$POOL_AFTER"
assert_eq "runtime invalido: no invoca herdr" "0" "$(wc -l < "$HERDR_STUB_LOG" | tr -d ' ')"

rm -f "$PANES_STATE"
OUT=$(run_collapse HERDR_ENV=1 HERDR_PANE_ID=w1:p0 HERDR_WORKSPACE_ID=w1)
RC=$?
STUB_CALLS=$(cat "$HERDR_STUB_LOG")
assert_eq "sin PANES_STATE previo: exit code 0" "0" "$RC"
assert_eq "sin PANES_STATE previo: stdout '0'" "0" "$OUT"
assert_eq "sin PANES_STATE previo: no invoca herdr" "0" "$(wc -l < "$HERDR_STUB_LOG" | tr -d ' ')"

# --- Resumen ---
echo ""
echo "Resultado: $PASS PASS, $FAIL FAIL"
[ "$FAIL" -eq 0 ]
