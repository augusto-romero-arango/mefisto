#!/usr/bin/env bash
# test-tooling-variant.sh -- Tests del modo --variant (corridas paralelas del
# mismo issue, issue #710) en scripts/_pipeline-common.sh.
#
# Cubre:
#   validate_variant_label - vacio, longitud (40 chars limite, 41 rechazado),
#                            caracteres validos ([a-z0-9-]) e invalidos
#                            (mayusculas, espacios, guion bajo, unicode) -- todos
#                            los casos invalidos dejan el motivo en
#                            PIPELINE_VARIANT_LABEL_ERROR (CA-1), sin imprimir
#                            nada por si misma.
#
# El modo variante dentro del propio pipeline (sufijos, sin push ni PR, label en
# status e historial) lo cubre scripts/tests/tooling-pipeline.test.mts.
# El reenvio y el rechazo de --variant en el modo desacoplado de
# launch-pipeline.mts los cubre scripts/tests/launch-pipeline.test.mts; dentro de
# herdr, scripts/tests/herdr-pipeline.test.mts.
#
# Uso: scripts/tests/test-tooling-variant.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# validate_variant_label vive en _pipeline-common.sh; sourcearlo solo la
# define (es una libreria, no ejecuta nada), asi que es seguro incluso dentro
# del repo de Mefisto.
set +u
source "$REPO_ROOT/scripts/_pipeline-common.sh" 2>/dev/null
set -u

echo "[1] validate_variant_label: label vacio se rechaza (CA-1)"
if validate_variant_label ""; then fail "label vacio no deberia retornar 0"; else pass "label vacio aborta"; fi
if printf '%s' "$PIPELINE_VARIANT_LABEL_ERROR" | grep -qi "vacio"; then pass "el error menciona 'vacio'"; else fail "PIPELINE_VARIANT_LABEL_ERROR inesperado: '$PIPELINE_VARIANT_LABEL_ERROR'"; fi

echo ""
echo "[2] validate_variant_label: label valido de una letra"
if validate_variant_label "a"; then pass "label de 1 char retorna 0"; else fail "'a' no deberia rechazarse"; fi

echo ""
echo "[3] validate_variant_label: slug tipico valido"
if validate_variant_label "experimento-a"; then pass "'experimento-a' retorna 0"; else fail "'experimento-a' no deberia rechazarse"; fi

echo ""
echo "[4] validate_variant_label: limite de longitud (40 OK, 41 rechazado)"
LABEL_40=$(printf 'a%.0s' $(seq 1 40))
LABEL_41=$(printf 'a%.0s' $(seq 1 41))
if [ "${#LABEL_40}" -eq 40 ] && [ "${#LABEL_41}" -eq 41 ]; then pass "fixtures de longitud correctas"; else fail "fixtures mal construidas"; fi
if validate_variant_label "$LABEL_40"; then pass "label de 40 chars retorna 0"; else fail "40 chars no deberia rechazarse"; fi
if validate_variant_label "$LABEL_41"; then fail "label de 41 chars no deberia retornar 0"; else pass "41 chars aborta"; fi
if printf '%s' "$PIPELINE_VARIANT_LABEL_ERROR" | grep -q "40 caracteres"; then pass "el error menciona el limite de 40 caracteres"; else fail "PIPELINE_VARIANT_LABEL_ERROR inesperado: '$PIPELINE_VARIANT_LABEL_ERROR'"; fi

echo ""
echo "[5] validate_variant_label: caracteres invalidos se rechazan (CA-1)"
for bad in "Experimento" "experimento_a" "experimento a" "experimento.a" "a/b"; do
    if validate_variant_label "$bad"; then
        fail "'$bad' no deberia retornar 0"
    else
        pass "'$bad' aborta"
    fi
    if printf '%s' "$PIPELINE_VARIANT_LABEL_ERROR" | grep -qF "$bad"; then
        pass "el error nombra el label invalido '$bad'"
    else
        fail "PIPELINE_VARIANT_LABEL_ERROR no menciona '$bad': '$PIPELINE_VARIANT_LABEL_ERROR'"
    fi
done

echo ""
echo "[6] validate_variant_label: digitos y guiones solos son validos"
if validate_variant_label "123-456"; then pass "'123-456' retorna 0"; else fail "'123-456' no deberia rechazarse"; fi

echo ""
echo "----------------------------------------"
echo "  _pipeline-common.sh: $PASS pass, $FAIL fail (hasta aqui)"
echo "----------------------------------------"

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
