#!/usr/bin/env bash
# test-internal-artifact-contract.sh -- Tests del contrato neutral de
# agentes/comandos internos (MEF-ADR-0049 CA-6, issue #853).
#
# Cubre:
#   [pre] El schema, el validador y jsonschema-lite.jq existen, tienen
#         sintaxis valida y el validador es ejecutable.
#   [valid] Cada fixture de fixtures/valid/ pasa el validador con exit 0.
#   [invalid] Cada fixture de fixtures/invalid/ se rechaza (exit != 0) Y el
#         mensaje contiene el motivo esperado -- para que un fixture invalido
#         no pase por la razon equivocada (CA-5).
#   [no-args] Sin argumentos, valida todo src/internal/{agents,commands} con
#         exit 0 -- hoy porque esas carpetas todavia no existen (este issue no
#         migra ningun agente real, ver CA-6/README.md) y despues de #865-#867
#         porque los artefactos migrados deben cumplir el contrato.
#
# Uso: .claude/scripts/tests/test-internal-artifact-contract.sh
# Exit code: 0 si todos los checks pasan, 1 si alguno falla.

set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CONTRACT_DIR="$REPO_ROOT/src/internal/contract"
VALIDATOR="$REPO_ROOT/src/internal/scripts/validate-internal-artifacts.sh"
SCHEMA_FILE="$CONTRACT_DIR/internal-artifact.schema.json"
JSONSCHEMA_LITE="$REPO_ROOT/src/internal/scripts/lib/jsonschema-lite.jq"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "[pre] El schema, el validador y jsonschema-lite.jq existen y tienen sintaxis valida"
for f in "$SCHEMA_FILE" "$VALIDATOR" "$JSONSCHEMA_LITE"; do
    if [ -f "$f" ]; then
        pass "existe: ${f#"$REPO_ROOT"/}"
    else
        fail "no existe: ${f#"$REPO_ROOT"/}"
    fi
done

if [ -x "$VALIDATOR" ]; then
    pass "validate-internal-artifacts.sh es ejecutable"
else
    fail "validate-internal-artifacts.sh no es ejecutable"
fi

if jq empty "$SCHEMA_FILE" 2>/dev/null; then
    pass "internal-artifact.schema.json es JSON valido"
else
    fail "internal-artifact.schema.json NO es JSON valido"
fi

if bash -n "$VALIDATOR" 2>/dev/null; then
    pass "validate-internal-artifacts.sh tiene sintaxis bash valida"
else
    fail "validate-internal-artifacts.sh tiene sintaxis bash invalida"
fi

if jq -n --argjson schema "$(cat "$SCHEMA_FILE")" --argjson instance '{}' -f "$JSONSCHEMA_LITE" >/dev/null 2>&1; then
    pass "jsonschema-lite.jq corre sin errores de sintaxis jq"
else
    fail "jsonschema-lite.jq tiene un error de sintaxis jq"
fi

echo ""
echo "[valid] fixtures/valid/*.md pasan el validador (exit 0)"
VALID_FIXTURES=$(find "$CONTRACT_DIR/fixtures/valid" -name '*.md' 2>/dev/null | sort)
if [ -z "$VALID_FIXTURES" ]; then
    fail "no hay fixtures en fixtures/valid/"
else
    while IFS= read -r fixture; do
        [ -n "$fixture" ] || continue
        rel="${fixture#"$REPO_ROOT"/}"
        OUT=$("$VALIDATOR" "$fixture" 2>&1)
        RC=$?
        if [ "$RC" -eq 0 ]; then
            pass "$rel -> exit 0"
        else
            fail "$rel -> exit $RC (esperaba 0). Salida: $OUT"
        fi
    done <<EOF
$VALID_FIXTURES
EOF
fi

echo ""
echo "[invalid] fixtures/invalid/*.md se rechazan (exit != 0) con el motivo esperado"

# check_invalid <nombre-fixture> <substring-esperado-en-el-mensaje>
# Corre el validador sobre un unico fixture de fixtures/invalid/ y comprueba
# tanto el exit code como que el motivo reportado sea el esperado -- un
# fixture invalido que se rechace por la razon equivocada (p. ej. un typo que
# lo vuelve JSON invalido en vez de probar la propiedad adicional que
# pretendia) no debe pasar el test en silencio.
check_invalid() {
    local name="$1" expected_substring="$2"
    local fixture="$CONTRACT_DIR/fixtures/invalid/$name"
    if [ ! -f "$fixture" ]; then
        fail "$name: fixture no existe"
        return
    fi
    local rel="${fixture#"$REPO_ROOT"/}"
    local out rc
    out=$("$VALIDATOR" "$fixture" 2>&1)
    rc=$?
    if [ "$rc" -eq 0 ]; then
        fail "$rel -> exit 0 (deberia rechazarse)"
        return
    fi
    if printf '%s' "$out" | grep -qF -- "$expected_substring"; then
        pass "$rel -> rechazado con el motivo esperado ('$expected_substring')"
    else
        fail "$rel -> rechazado pero SIN el motivo esperado ('$expected_substring'). Salida: $out"
    fi
}

check_invalid "mefisto-invalid-model-field.md" "model: propiedad adicional"
check_invalid "mefisto-invalid-tools-field.md" "tools: propiedad adicional"
check_invalid "mefisto-invalid-permission-field.md" "permission: propiedad adicional"
check_invalid "mefisto-invalid-allowed-tools-field.md" "allowed-tools: propiedad adicional"
check_invalid "mefisto-invalid-profile-value.md" "profile: valor"
check_invalid "mefisto-invalid-capability-value.md" "capabilities"
check_invalid "mefisto-invalid-extra-property.md" "foo: propiedad adicional"
check_invalid "no-frontmatter.md" "frontmatter: ausente"
check_invalid "frontmatter-not-json.md" "no es JSON valido"
check_invalid "mismatched-id.md" "distinto del nombre de archivo"
check_invalid "mefisto-missing-mode.md" "mode: campo requerido ausente"
check_invalid "mefisto-missing-effort.md" "effort: campo requerido ausente"
check_invalid "mefisto-invalid-effort-value.md" "effort: valor"
check_invalid "mefisto-id-not-string.md" "id: tipo esperado string"
check_invalid "mefisto-body-runtime-reference.md" "nombra un runtime concreto"

echo ""
echo "[no-args] Sin argumentos: valida todo src/internal/{agents,commands}"
# Vale tanto hoy (las carpetas todavia no existen: #853 no migra ningun
# artefacto real) como despues de #865-#867: una migracion correcta deja todos
# los agentes/comandos reales pasando el contrato, asi que exit 0 es la
# expectativa en ambos casos y el check no se auto-desactiva al aparecer las
# carpetas.
OUT=$("$VALIDATOR" 2>&1)
RC=$?
if [ "$RC" -eq 0 ]; then
    pass "src/internal/{agents,commands} valida completo -> exit 0"
else
    fail "exit $RC sin argumentos (deberia ser 0). Salida: $OUT"
fi

echo ""
echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
[ "$FAIL" -eq 0 ]
