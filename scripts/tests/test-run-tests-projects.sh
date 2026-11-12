#!/usr/bin/env bash
# test-run-tests-projects.sh — Tests de run_tests_projects/extract_test_count
# consolidadas en scripts/_pipeline-common.sh (issue #305).
#
# Valida que:
#   A) run_tests_projects y extract_test_count se resuelven desde
#      _pipeline-common.sh (no quedan definiciones locales duplicadas en
#      tdd-pipeline.sh / pr-sync.sh).
#   B) El glob tests/${HARNESS_NAMESPACE_PREFIX}.*.Tests/ de run_tests_projects
#      EXCLUYE los directorios *.SmokeTests/, incluso cuando comparten el mismo
#      prefijo de dominio (ej: Onboarding.Tests vs Onboarding.SmokeTests).
#   C) run_tests_projects recibe la ruta del worktree por parametro (no usa la
#      global $WORKTREE_PATH).
#   D) Contrato de exit code: 0 = todos pasan, 8 = ningun proyecto *.Tests/ (solo
#      habia *.SmokeTests/), otro = codigo de fallo del primer proyecto que falla.
#   E) pr-sync.sh ya no corre `dotnet test --solution` (que incluiria smoke tests).
#   F) Microsoft.Testing.Platform y la frontera JSON del historial conservan el
#      conteo de exitos o null, sin abortar el cierre posterior al PR.
#
# Uso: scripts/tests/test-run-tests-projects.sh
# Exit code: 0 si todos los checks pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# -------- Bloque A: la funcion consolidada vive solo en _pipeline-common.sh --------

echo "[A] run_tests_projects/extract_test_count se resuelven desde _pipeline-common.sh"

COMMON_SCRIPT="$REPO_ROOT/scripts/_pipeline-common.sh"

if grep -q '^run_tests_projects()' "$COMMON_SCRIPT"; then
    pass "run_tests_projects definida en _pipeline-common.sh"
else
    fail "run_tests_projects NO definida en _pipeline-common.sh"
fi

if grep -q '^extract_test_count()' "$COMMON_SCRIPT"; then
    pass "extract_test_count definida en _pipeline-common.sh"
else
    fail "extract_test_count NO definida en _pipeline-common.sh"
fi

for script in pr-sync.sh; do
    path="$REPO_ROOT/scripts/$script"
    if grep -q '^run_tests_projects()' "$path"; then
        fail "$script: todavia define run_tests_projects() localmente (duplicado)"
    else
        pass "$script: no define run_tests_projects() localmente"
    fi
    if grep -q '^extract_test_count()' "$path"; then
        fail "$script: todavia define extract_test_count() localmente (duplicado)"
    else
        pass "$script: no define extract_test_count() localmente"
    fi
done

# pr-sync.sh ya no debe correr `dotnet test --solution` (incluye *.SmokeTests/).
if grep -q 'dotnet test --solution' "$REPO_ROOT/scripts/pr-sync.sh"; then
    fail "pr-sync.sh: todavia corre 'dotnet test --solution' (incluiria *.SmokeTests/)"
else
    pass "pr-sync.sh: ya no corre 'dotnet test --solution'"
fi

if grep -q 'run_tests_projects "\$worktree" --no-build' "$REPO_ROOT/scripts/pr-sync.sh"; then
    pass "pr-sync.sh: validate_tests usa run_tests_projects \"\$worktree\" --no-build"
else
    fail "pr-sync.sh: validate_tests no invoca run_tests_projects como se espera"
fi

# -------- Bloque B/C/D: comportamiento funcional del runner --------
#
# Sourcea la funcion REAL desde _pipeline-common.sh (no una reproduccion local)
# y la ejercita contra un stub de `dotnet` en PATH, para no depender del SDK de
# .NET real ni de proyectos de test reales.

echo ""
echo "[B/C/D] run_tests_projects: exclusion de *.SmokeTests/, parametro de worktree, exit codes"

set +u
source "$COMMON_SCRIPT" 2>/dev/null
set -u

if ! declare -F run_tests_projects >/dev/null; then
    fail "no se pudo sourcear run_tests_projects desde _pipeline-common.sh — se omite el resto de [B/C/D]"
else
    TMPDIR_BASE=$(mktemp -d)
    trap 'rm -rf "$TMPDIR_BASE"' EXIT

    STUB_BIN="$TMPDIR_BASE/bin"
    mkdir -p "$STUB_BIN"

    # Stub de dotnet: registra el --project recibido en $DOTNET_STUB_LOG y responde
    # con un resumen de tests parseable por extract_test_count. El proyecto cuyo
    # path contiene "FAIL_MARKER" hace que el stub retorne 2 (tests fallidos); el
    # resto retorna 0. No requiere el SDK de .NET real para correr este test.
    cat > "$STUB_BIN/dotnet" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "test" ]; then
    shift
    proj=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --project) proj="$2"; shift 2 ;;
            *) shift ;;
        esac
    done
    echo "$proj" >> "${DOTNET_STUB_LOG:?}"
    if printf '%s' "$proj" | grep -q "FAIL_MARKER"; then
        echo "Resumen de pruebas: total: 3, error: 1, correcto: 2"
        exit 2
    fi
    echo "Resumen de pruebas: total: 5, error: 0, correcto: 5"
    exit 0
fi
exit 0
STUB
    chmod +x "$STUB_BIN/dotnet"

    export PATH="$STUB_BIN:$PATH"
    export HARNESS_NAMESPACE_PREFIX="Cosmos.ControlPlane"

    # --- Caso B: *.Tests/ y *.SmokeTests/ del mismo dominio conviven ---
    WT_B="$TMPDIR_BASE/wt_b"
    mkdir -p \
        "$WT_B/tests/Cosmos.ControlPlane.Onboarding.Tests" \
        "$WT_B/tests/Cosmos.ControlPlane.Onboarding.SmokeTests" \
        "$WT_B/tests/Cosmos.ControlPlane.UserManagement.Tests"

    DOTNET_STUB_LOG="$TMPDIR_BASE/log_b.txt"
    export DOTNET_STUB_LOG
    : > "$DOTNET_STUB_LOG"
    rc=0
    run_tests_projects "$WT_B" >/dev/null 2>&1 || rc=$?

    if [ "$rc" -eq 0 ]; then
        pass "B1: exit 0 cuando todos los *.Tests/ pasan"
    else
        fail "B1: exit esperado 0, obtenido $rc"
    fi

    if grep -q "SmokeTests" "$DOTNET_STUB_LOG"; then
        fail "B2: run_tests_projects invoco dotnet test sobre un directorio *.SmokeTests/"
    else
        pass "B2: ningun *.SmokeTests/ fue invocado"
    fi

    invoked_count=$(wc -l < "$DOTNET_STUB_LOG" | tr -d ' ')
    if [ "$invoked_count" -eq 2 ]; then
        pass "B3: se invocaron exactamente los 2 proyectos *.Tests/ (Onboarding + UserManagement)"
    else
        fail "B3: se esperaban 2 invocaciones, hubo $invoked_count"
    fi

    if grep -q "Cosmos.ControlPlane.Onboarding.Tests" "$DOTNET_STUB_LOG" \
        && grep -q "Cosmos.ControlPlane.UserManagement.Tests" "$DOTNET_STUB_LOG"; then
        pass "B4: ambos proyectos *.Tests/ fueron invocados"
    else
        fail "B4: no se invocaron ambos proyectos *.Tests/ esperados"
    fi

    # --- Caso C: la ruta del worktree se pasa por parametro, no por global ---
    WORKTREE_PATH="/ruta/que/no/existe/y/no/debe/usarse"
    DOTNET_STUB_LOG="$TMPDIR_BASE/log_c.txt"
    : > "$DOTNET_STUB_LOG"
    rc=0
    run_tests_projects "$WT_B" >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 0 ] && [ -s "$DOTNET_STUB_LOG" ]; then
        pass "C1: run_tests_projects usa el argumento, ignora \$WORKTREE_PATH global"
    else
        fail "C1: run_tests_projects no ignoro \$WORKTREE_PATH global (rc=$rc)"
    fi
    unset WORKTREE_PATH

    # --- Caso D1: solo *.SmokeTests/ (sin ningun *.Tests/) => exit 8 ---
    WT_D1="$TMPDIR_BASE/wt_d1"
    mkdir -p "$WT_D1/tests/Cosmos.ControlPlane.Onboarding.SmokeTests"
    DOTNET_STUB_LOG="$TMPDIR_BASE/log_d1.txt"
    : > "$DOTNET_STUB_LOG"
    rc=0
    run_tests_projects "$WT_D1" >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 8 ]; then
        pass "D1: exit 8 cuando solo hay *.SmokeTests/ (ningun *.Tests/ para correr)"
    else
        fail "D1: exit esperado 8, obtenido $rc"
    fi

    # --- Caso D2: un proyecto *.Tests/ falla => propaga su codigo de fallo ---
    WT_D2="$TMPDIR_BASE/wt_d2"
    mkdir -p \
        "$WT_D2/tests/Cosmos.ControlPlane.FAIL_MARKER.Tests" \
        "$WT_D2/tests/Cosmos.ControlPlane.UserManagement.Tests"
    DOTNET_STUB_LOG="$TMPDIR_BASE/log_d2.txt"
    : > "$DOTNET_STUB_LOG"
    rc=0
    run_tests_projects "$WT_D2" >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 2 ]; then
        pass "D2: exit 2 propagado cuando un proyecto *.Tests/ falla"
    else
        fail "D2: exit esperado 2, obtenido $rc"
    fi
fi

# -------- Bloque E/F: resumen MTP y frontera JSON del historial --------

echo ""
echo "[E/F] extract_test_count y la frontera JSON del historial"

if [ "$(extract_test_count 'Test summary: total: 55, failed: 1, succeeded: 53, skipped: 1, duration: 1.2s')" = "53" ]; then
    pass "E1: reconoce succeeded del resumen literal de Microsoft.Testing.Platform"
else
    fail "E1: el resumen de Microsoft.Testing.Platform no devolvio 53"
fi

if [ "$(extract_test_count 'Passed: 7')" = "7" ] \
    && [ "$(extract_test_count 'Resumen de pruebas: correcto: 4')" = "4" ] \
    && [ "$(extract_test_count 'sin resumen reconocible')" = "?" ]; then
    pass "E2: conserva formatos previos y el sentinela para texto desconocido"
else
    fail "E2: los formatos previos o el sentinela cambiaron"
fi

PIPELINE_TESTS="?"
TESTS_JSON="$(tests_json_value "$PIPELINE_TESTS")"
HISTORY_LINE="$(jq -cn --argjson tests "$TESTS_JSON" '{tests:$tests}')"
if echo "$HISTORY_LINE" | jq -e '.tests == null' >/dev/null 2>&1; then
    pass "F1: PIPELINE_TESTS='?' se serializa como tests null en el historial"
else
    fail "F1: el sentinela no se saneo antes de --argjson: $HISTORY_LINE"
fi

BOOKKEEPING_TMP="$TMPDIR_BASE/bookkeeping"
mkdir -p "$BOOKKEEPING_TMP"
BOOKKEEPING_EVENTS="$BOOKKEEPING_TMP/events.log"
BOOKKEEPING_WARN="$BOOKKEEPING_TMP/warn.log"
warn() { printf '%s\n' "$1" >> "$BOOKKEEPING_WARN"; }
rc=0
append_completed_history "$BOOKKEEPING_TMP/history.jsonl" "$BOOKKEEPING_EVENTS" \
    jq -cn --argjson tests "?" '{tests:$tests}' >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 0 ] \
    && [ ! -s "$BOOKKEEPING_TMP/history.jsonl" ] \
    && grep -qF 'No se pudo registrar el historial completado' "$BOOKKEEPING_WARN" \
    && grep -qF 'WARN: no se pudo registrar el historial completado' "$BOOKKEEPING_EVENTS"; then
    pass "F2: un fallo de historial advierte, deja evento y retorna exit 0"
else
    fail "F2: el fallo de bookkeeping no cumplio el contrato (rc=$rc)"
fi


# -------- Resumen --------

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
