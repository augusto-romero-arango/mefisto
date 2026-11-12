#!/usr/bin/env bash
# test-parallel-projection-serialization.sh -- Tests de los helpers de
# serializacion de tipo:projection (scripts/_pipeline-common.sh, issue #372).
#
# parallel-pipeline serializa entre si cualquier par de issues tipo:projection
# de un mismo lote (comparten los archivos del worker de proyecciones del BC,
# MEF-ADR-0034), sin necesitar deteccion de BC (un repo = un BC, MEF-ADR-0023).
# Estos tests cubren los helpers PUROS de la libreria bash que implementan esa
# regla, sin lanzar background jobs reales ni depender de gh/red; el scheduler
# se prueba en scripts/tests/parallel-pipeline.test.mts:
#
#   S-1: _is_tipo_projection_from_labels reconoce el label EXACTO tipo:projection
#        y no un prefijo como tipo:projection-experimental.
#   S-2: resolve_issue_facts (gh mockeado) reporta el flag de projection desde la
#        MISMA llamada a gh que ya trae estado y pipeline -- una sola consulta por
#        issue --, y resolve_pipeline_with_state sigue devolviendo dos campos.
#   S-3: can_launch_now cubre la matriz de las 4 combinaciones de
#        (limite de paralelismo alcanzado) x (projection ya corriendo).
#
# Uso: scripts/tests/test-parallel-projection-serialization.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

source "$REPO_ROOT/scripts/_pipeline-common.sh"

echo "[pre] herdr-pipeline.sh no conserva rutas legacy de escritura"
if grep -q '\.claude/pipeline/logs' "$REPO_ROOT/scripts/herdr-pipeline.sh"; then
    fail "herdr-pipeline.sh conserva una ruta legacy de escritura"
else
    pass "herdr-pipeline.sh no conserva rutas legacy de escritura"
fi

echo "[S-1] _is_tipo_projection_from_labels: label exacto vs. prefijo"

if _is_tipo_projection_from_labels "estado:listo
tipo:projection
dom:facturacion"; then
    pass "labels con tipo:projection exacto -> reconocido"
else
    fail "labels con tipo:projection exacto -> se esperaba reconocido"
fi

if _is_tipo_projection_from_labels "tipo:projection-experimental"; then
    fail "prefijo tipo:projection-experimental -> NO deberia reconocerse como projection"
else
    pass "prefijo tipo:projection-experimental -> correctamente descartado"
fi

if _is_tipo_projection_from_labels "tipo:feature
estado:listo"; then
    fail "labels sin tipo:projection -> NO deberia reconocerse como projection"
else
    pass "labels sin tipo:projection -> correctamente descartado"
fi

if _is_tipo_projection_from_labels ""; then
    fail "labels vacios -> NO deberia reconocerse como projection"
else
    pass "labels vacios -> correctamente descartado"
fi

echo ""
echo "[S-2] resolve_issue_facts (gh mockeado): estado + projection + pipeline en UNA consulta"
# parallel-pipeline.sh consume esta funcion y NO una segunda llamada a gh por
# issue: el flag de projection sale de los mismos labels que ya resuelven el
# pipeline. El mock emite el formato "STATE|label\nlabel..." que gh produce tras
# aplicar el -q de la funcion.

# facts_field <facts> <n>  -> campo n (1..3) de "STATE|IS_PROJECTION|PIPELINE"
facts_field() {
    local facts="$1" n="$2"
    case "$n" in
        1) echo "${facts%%|*}" ;;
        2) facts="${facts#*|}"; echo "${facts%%|*}" ;;
        3) facts="${facts#*|}"; echo "${facts#*|}" ;;
    esac
}

GH_CALLS=$(mktemp)
FACTS=$( { gh() { echo "call" >>"$GH_CALLS"; printf 'OPEN|tipo:projection\nestado:listo\n'; }; resolve_issue_facts 999; } )
CALLS=$(wc -l <"$GH_CALLS" | tr -d ' ')
rm -f "$GH_CALLS"

if [ "$(facts_field "$FACTS" 1)" = "OPEN" ]; then
    pass "tipo:projection -> estado OPEN antepuesto"
else
    fail "tipo:projection -> se esperaba estado OPEN, fue '$(facts_field "$FACTS" 1)'"
fi

if [ "$(facts_field "$FACTS" 2)" = "true" ]; then
    pass "tipo:projection -> flag de projection en true"
else
    fail "tipo:projection -> se esperaba flag true, fue '$(facts_field "$FACTS" 2)'"
fi

case "$(facts_field "$FACTS" 3)" in
    /*tdd-pipeline.sh) pass "tipo:projection -> ruta absoluta a tdd-pipeline.sh" ;;
    *) fail "tipo:projection -> se esperaba ruta absoluta a tdd-pipeline.sh, fue '$(facts_field "$FACTS" 3)'" ;;
esac

if [ "$CALLS" = "1" ]; then
    pass "una sola llamada a gh por issue (estado + labels + projection combinados)"
else
    fail "se esperaba 1 llamada a gh por issue, hubo $CALLS"
fi

FACTS=$( { gh() { printf 'OPEN|tipo:feature\n'; }; resolve_issue_facts 998; } )
if [ "$(facts_field "$FACTS" 2)" = "false" ]; then
    pass "tipo:feature -> flag de projection en false"
else
    fail "tipo:feature -> se esperaba flag false, fue '$(facts_field "$FACTS" 2)'"
fi

FACTS=$( { gh() { return 1; }; resolve_issue_facts 997; } )
if [ "$(facts_field "$FACTS" 1)|$(facts_field "$FACTS" 2)|$(facts_field "$FACTS" 3)" = "UNKNOWN|false|SKIP:no-tipo" ]; then
    pass "gh falla -> UNKNOWN|false|SKIP:no-tipo (degrada, no aborta el lote)"
else
    fail "gh falla -> se esperaba 'UNKNOWN|false|SKIP:no-tipo', fue '$FACTS'"
fi

# Con override el flag se sigue reportando desde los labels: forzar --pipeline no
# cambia que archivos del worker toca el issue, asi que la serializacion se mantiene.
FACTS=$( { gh() { printf 'OPEN|tipo:projection\n'; }; resolve_issue_facts 996 tdd; } )
if [ "$(facts_field "$FACTS" 2)" = "true" ]; then
    pass "override tdd + tipo:projection -> flag sigue en true (se serializa igual)"
else
    fail "override tdd + tipo:projection -> se esperaba flag true, fue '$(facts_field "$FACTS" 2)'"
fi

# El contrato de dos campos de resolve_pipeline_with_state (batch-pipeline.sh y
# launch-pipeline.sh lo parsean asi) no debe filtrar el campo nuevo del medio.
RESULT=$( { gh() { printf 'OPEN|tipo:projection\n'; }; resolve_pipeline_with_state 995; } )
if [ "${RESULT%%|*}" = "OPEN" ]; then
    pass "resolve_pipeline_with_state: primer campo sigue siendo el estado"
else
    fail "resolve_pipeline_with_state: se esperaba estado OPEN, fue '${RESULT%%|*}'"
fi
# Si el flag intermedio se filtrara, este campo seria "true|/...".
case "${RESULT#*|}" in
    /*tdd-pipeline.sh) pass "resolve_pipeline_with_state: segundo campo sigue siendo el pipeline (sin filtrar el flag)" ;;
    *) fail "resolve_pipeline_with_state: se esperaba la ruta del pipeline, fue '${RESULT#*|}'" ;;
esac

RESULT=$( { gh() { return 1; }; resolve_pipeline_with_state 994 no-existe 2>/dev/null; } )
if [ -z "$RESULT" ]; then
    pass "resolve_pipeline_with_state con override invalido -> sin stdout (propaga el error)"
else
    fail "resolve_pipeline_with_state con override invalido -> se esperaba stdout vacio, fue '$RESULT'"
fi

echo ""
echo "[S-3] can_launch_now: matriz de 4 combinaciones"

# can_launch_now <max_parallel> <running_count> <is_projection> <projection_running>

if can_launch_now 0 5 "false" "false"; then
    pass "sin limite, no-projection, sin projection corriendo -> lanza"
else
    fail "sin limite, no-projection, sin projection corriendo -> se esperaba lanzar"
fi

if can_launch_now 0 5 "true" "false"; then
    pass "sin limite, projection, sin projection corriendo -> lanza"
else
    fail "sin limite, projection, sin projection corriendo -> se esperaba lanzar"
fi

if can_launch_now 0 5 "true" "true"; then
    fail "sin limite, projection, YA hay projection corriendo -> NO deberia lanzar"
else
    pass "sin limite, projection, YA hay projection corriendo -> correctamente bloqueado"
fi

if can_launch_now 2 2 "false" "false"; then
    fail "limite alcanzado (2/2), no-projection -> NO deberia lanzar"
else
    pass "limite alcanzado (2/2), no-projection -> correctamente bloqueado"
fi

if can_launch_now 2 1 "false" "false"; then
    pass "bajo el limite (1/2), no-projection -> lanza"
else
    fail "bajo el limite (1/2), no-projection -> se esperaba lanzar"
fi

if can_launch_now 2 1 "true" "true"; then
    fail "bajo el limite (1/2) pero YA hay projection corriendo -> NO deberia lanzar"
else
    pass "bajo el limite (1/2) pero YA hay projection corriendo -> correctamente bloqueado (ambas condiciones aplican)"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
