#!/usr/bin/env bash
# test-launch-preparse.sh -- Tests del pre-parseo de scripts/launch-pipeline.sh
# (issue #449: retomar una corrida caida desde el despachador).
#
# launch-pipeline.sh termina con `main "$@"` a nivel superior y arranca con un
# guard defensivo que aborta si se ejecuta dentro del repo de Mefisto -- no se
# puede sourcear para testear el pre-parseo sin ejecutarlo. Este test lo corre
# como SUBPROCESO real, sin tocar ese guard ni el entrypoint:
#   - Un "consumidor" falso (mktemp -d + git init, sin .claude-plugin/plugin.json)
#     hace que el guard defensivo pase, igual que FAKE_CONSUMER en
#     test-pipeline-resolver.sh.
#   - Una copia del paquete publicado cuyos sub-pipelines son stubs que
#     imprimen sus argumentos: el report log de cada corrida desacoplada deja
#     ver que recibio el sub-pipeline.
#   - --pipeline tooling evita que resolve_pipeline llame a `gh` (no hay red
#     en el test).
#
# Cubre:
#   T-1 (CA-1, regresion explicita del AC): "253 --from-stage 4" despacha a
#       cmd_single (corrida de un unico issue), NO a cmd_parallel via el
#       fallback "Multiples issues sin modo especificado".
#   T-2 (CA-2): el sub-pipeline recibe "<issue> --from-stage N", solo y
#       combinado con --scaffold-domain.
#   T-3 (CA-2): --from-stage sin valor, o con valor no numerico, aborta con
#       mensaje claro (mismo patron que --scaffold-domain/--pipeline).
#   T-4 (Notas tecnicas): --from-stage con --batch, --parallel, o multiples
#       issues sin modo, aborta (ambiguo sobre un lote).
#   T-6 (CA-2, ningun modo se traga el flag en silencio): --tooling e --infra
#       tambien lo propagan (sus sub-scripts aceptan --from-stage), y --scaffold,
#       que no puede usarlo, lo rechaza con mensaje. Un flag aceptado y
#       descartado sin aviso arrancaria de Stage 1 sobre un worktree con
#       commits -- el dano exacto que este issue evita.
#   T-7: invocar solo flags, sin argumento posicional, sale con el mensaje de
#       uso y no con el "unbound variable" de bash 3.2 al expandir un array
#       filtered_args vacio bajo `set -u`.
#
# Uso: scripts/tests/test-launch-preparse.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

# Dentro de un pane herdr la autodeteccion delegaria cada invocacion a
# herdr-pipeline.sh y crearia PANES REALES en el workspace del humano: el modo
# desacoplado se fija explicito.
export MEFISTO_UI=mod

# Runtime fijo: la resolucion no debe depender de los CLIs de la maquina.
export MEFISTO_RUNTIME=claude

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

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

assert_rc() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        pass "$desc (rc=$actual)"
    else
        fail "$desc -- se esperaba rc=$expected, fue rc=$actual"
    fi
}

# --- Consumidor falso y copia del paquete con sub-pipelines stub ---
FAKE_CONSUMER="$(mktemp -d)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$FAKE_CONSUMER" "$TMP_DIR"' EXIT

(cd "$FAKE_CONSUMER" && git init -q)

PKG="$TMP_DIR/pkg"
mkdir -p "$PKG/scripts" "$PKG/src"
cp "$REPO_ROOT"/scripts/*.sh "$PKG/scripts/"
ln -s "$REPO_ROOT/src/runtime" "$PKG/src/runtime"
for s in tdd tooling iac scaffold batch parallel; do
    printf '#!/usr/bin/env bash\necho "stub %s $*"\n' "$s" > "$PKG/scripts/$s-pipeline.sh"
done
chmod +x "$PKG"/scripts/*.sh
LAUNCH_SCRIPT="$PKG/scripts/launch-pipeline.sh"

LAST_STDOUT=""
LAST_STDERR=""
LAST_RC=0

# run_wrapper <args...>
#
# Corre launch-pipeline.sh como subproceso real (cwd = FAKE_CONSUMER, sin TTY)
# y borra antes los report logs de la corrida anterior.
run_wrapper() {
    find "$FAKE_CONSUMER" -name '*.report.log' -delete 2>/dev/null
    local out="$TMP_DIR/stdout" err="$TMP_DIR/stderr"
    (
        cd "$FAKE_CONSUMER" || exit 99
        # Hermetico: el pipeline exporta estas rutas y desviarian el estado fuera del consumidor falso.
        unset MEFISTO_STATE_DIR MEFISTO_LEGACY_STATE_DIR MEFISTO_REPO_ROOT MEFISTO_MODELS_FILE
        "$LAUNCH_SCRIPT" "$@"
    ) </dev/null >"$out" 2>"$err"
    LAST_RC=$?
    LAST_STDOUT=$(cat "$out")
    LAST_STDERR=$(cat "$err")
}

# report_of <prefijo>: contenido del report log <prefijo>-run-*.report.log,
# esperando a que el sub-pipeline desacoplado lo escriba.
report_of() {
    local i=0 f=""
    while [ $i -lt 50 ]; do
        f=$(find "$FAKE_CONSUMER" -name "$1-run-*.report.log" -size +0 2>/dev/null | head -n1)
        [ -n "$f" ] && break
        sleep 0.1
        i=$((i+1))
    done
    [ -n "$f" ] && cat "$f"
}
report_names() { find "$FAKE_CONSUMER" -name '*.report.log' -exec basename {} \; 2>/dev/null; }

echo "[T-1] --from-stage con un unico issue despacha a cmd_single, no a cmd_parallel (CA-1)"
run_wrapper 253 --from-stage 4 --pipeline tooling
assert_rc "cmd_single corre sin abortar" 0 "$LAST_RC"
assert_not_contains "sin warning de 'Multiples issues'" "$LAST_STDOUT" "Multiples issues"
REPORT=$(report_of "tooling-pipeline-issue-253")
assert_contains "corrida de un unico issue (tooling-pipeline-issue-253)" "$(report_names)" "tooling-pipeline-issue-253-run-"
assert_not_contains "no lanza una corrida 'parallel-*'" "$(report_names)" "parallel-run-"

echo ""
echo "[T-2] el sub-pipeline recibe <issue> --from-stage N (CA-2)"
assert_contains "el sub-pipeline recibe '253 --from-stage 4'" "$REPORT" "stub tooling 253 --from-stage 4"

run_wrapper 253 --from-stage 4 --scaffold-domain miDominio --pipeline tooling
assert_rc "combinado con --scaffold-domain corre sin abortar" 0 "$LAST_RC"
assert_contains "combina --scaffold-domain y --from-stage en orden" "$(report_of "tooling-pipeline-issue-253")" "stub tooling 253 --scaffold-domain miDominio --from-stage 4"

echo ""
echo "[T-3] --from-stage sin valor o no numerico aborta con mensaje claro"
run_wrapper 253 --pipeline tooling --from-stage
assert_rc "--from-stage al final (sin valor) aborta" 1 "$LAST_RC"
assert_contains "mensaje: falta el valor" "$LAST_STDERR" "Falta el valor de --from-stage"

run_wrapper 253 --from-stage abc --pipeline tooling
assert_rc "--from-stage abc (no numerico) aborta" 1 "$LAST_RC"
assert_contains "mensaje: debe ser un numero entero" "$LAST_STDERR" "--from-stage debe ser un numero entero"

echo ""
echo "[T-4] --from-stage sobre un lote de issues es ambiguo: se rechaza"
run_wrapper --batch 253 254 --from-stage 4
assert_rc "--batch + --from-stage aborta" 1 "$LAST_RC"
assert_contains "mensaje: no valido con --batch" "$LAST_STDERR" "no es valido con --batch"

run_wrapper --parallel 253 254 --from-stage 4
assert_rc "--parallel + --from-stage aborta" 1 "$LAST_RC"
assert_contains "mensaje: no valido con --parallel" "$LAST_STDERR" "no es valido con --parallel"

run_wrapper 253 254 --from-stage 4
assert_rc "multiples issues sin modo + --from-stage aborta" 1 "$LAST_RC"
assert_contains "mensaje: no valido con multiples issues" "$LAST_STDERR" "no es valido con multiples issues"
assert_not_contains "un rechazo no lanza ninguna corrida" "$(report_names)" ".report.log"

echo ""
echo "[T-6] ningun modo se traga --from-stage en silencio (CA-2)"

# --tooling e --infra son modos de un unico issue y sus sub-scripts aceptan
# --from-stage (rango 1-2): deben propagarlo.
run_wrapper --tooling 253 --from-stage 2
assert_rc "--tooling + --from-stage corre sin abortar" 0 "$LAST_RC"
assert_contains "--tooling propaga el flag al sub-pipeline" "$(report_of "tooling-issue-253")" "stub tooling 253 --from-stage 2"

run_wrapper --infra 253 --from-stage 2
assert_rc "--infra + --from-stage corre sin abortar" 0 "$LAST_RC"
assert_contains "--infra propaga el flag al sub-pipeline" "$(report_of "infra-issue-253")" "stub iac 253 --from-stage 2"

# --scaffold no tiene stages retomables: rechaza en vez de callar.
run_wrapper --scaffold 253 --domain miDominio --from-stage 2
assert_rc "--scaffold + --from-stage aborta" 1 "$LAST_RC"
assert_contains "mensaje: no valido con --scaffold" "$LAST_STDERR" "no es valido con --scaffold"

echo ""
echo "[T-7] solo flags, sin argumento posicional: mensaje de uso, no error de bash"
run_wrapper --from-stage 4
assert_rc "aborta" 1 "$LAST_RC"
assert_contains "mensaje: faltan argumentos posicionales" "$LAST_STDERR" "Faltan argumentos posicionales"
assert_not_contains "sin 'unbound variable' de bash 3.2" "$LAST_STDERR" "unbound variable"

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
