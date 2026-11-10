#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONTRACT_DIR="$REPO_ROOT/src/published/contract"
VALIDATOR="$REPO_ROOT/src/published/scripts/validate-published-artifacts.sh"
MCP_VALIDATOR="$REPO_ROOT/src/published/scripts/validate-published-mcp.sh"
MCP_FIXTURES="$CONTRACT_DIR/fixtures/mcp"
PASS=0 FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "[pre] contrato publicado"
for f in "$CONTRACT_DIR/published-artifact.schema.json" "$CONTRACT_DIR/mcp-servers.json" "$CONTRACT_DIR/mcp-servers.schema.json" "$VALIDATOR" "$MCP_VALIDATOR" "$REPO_ROOT/src/published/scripts/lib/jsonschema-lite.jq"; do [ -f "$f" ] && pass "existe: ${f#"$REPO_ROOT"/}" || fail "no existe: ${f#"$REPO_ROOT"/}"; done
[ -x "$VALIDATOR" ] && pass "validador ejecutable" || fail "validador no ejecutable"
[ -x "$MCP_VALIDATOR" ] && pass "validador MCP ejecutable" || fail "validador MCP no ejecutable"
grep -q '^#!/usr/bin/env bash$' "$VALIDATOR" && pass "validador declara intérprete Bash" || fail "validador sin shebang Bash"
jq empty "$CONTRACT_DIR/published-artifact.schema.json" >/dev/null 2>&1 && pass "schema JSON válido" || fail "schema JSON inválido"
bash -n "$VALIDATOR" >/dev/null 2>&1 && pass "sintaxis Bash válida" || fail "sintaxis Bash inválida"
bash -n "$MCP_VALIDATOR" >/dev/null 2>&1 && pass "sintaxis Bash MCP válida" || fail "sintaxis Bash MCP inválida"

echo "[valid] fixtures válidos"
for f in "$CONTRACT_DIR"/fixtures/valid/*.md; do out=$(bash "$VALIDATOR" "$f" 2>&1); rc=$?; [ "$rc" -eq 0 ] && pass "$(basename "$f")" || fail "$(basename "$f"): $out"; done

echo "[invalid] fixtures inválidos"
check_invalid() {
    local name="$1" expected="$2" out rc
    out=$(bash "$VALIDATOR" "$CONTRACT_DIR/fixtures/invalid/$name" 2>&1); rc=$?
    if [ "$rc" -eq 0 ]; then fail "$name fue aceptado"
    elif printf '%s' "$out" | grep -qF -- "$expected"; then pass "$name: $expected"
    else fail "$name fue rechazado por otro motivo: $out"
    fi
}
check_invalid_exact() {
    local name="$1" expected="$2" out rc
    out=$(bash "$VALIDATOR" "$CONTRACT_DIR/fixtures/invalid/$name" 2>&1); rc=$?
    if [ "$rc" -eq 0 ]; then fail "$name fue aceptado"
    elif [ "$out" = "$expected" ]; then pass "$name conserva diagnostico exacto"
    else fail "$name cambio su diagnostico: $out"
    fi
}
check_invalid "frontmatter-not-json.md" "frontmatter: no es JSON valido"
check_invalid "missing-description.md" "description: campo requerido ausente"
check_invalid "extra-property.md" "foo: propiedad adicional no permitida"
check_invalid "invalid-kind.md" "kind: valor"
check_invalid "invalid-profile.md" "profile: valor"
check_invalid "invalid-mode.md" "mode: valor"
check_invalid "missing-mode.md" "mode: campo requerido ausente"
check_invalid "missing-effort.md" "effort: campo requerido ausente"
check_invalid "invalid-effort.md" "effort: valor"
check_invalid "effort-on-command.md" "effort: propiedad adicional"
check_invalid "invalid-capability.md" "capabilities.0: valor"
check_invalid "mismatched-id.md" "id: 'other-id' distinto"
check_invalid "mefisto-prefixed-id.md" "id: 'mefisto-prefixed-id' no coincide"
check_invalid "id-with-colon.md" "id: 'mefisto:id-with-colon' no coincide"
check_invalid "model-field.md" "model: propiedad adicional"
check_invalid "tools-field.md" "tools: propiedad adicional"
check_invalid "allowed-tools-field.md" "allowed-tools: propiedad adicional"
check_invalid "permission-field.md" "permission: propiedad adicional"
check_invalid "mode-on-command.md" "mode: propiedad adicional"
check_invalid "command-fields-on-agent.md" "agent: propiedad adicional"
check_invalid_exact "body-runtime-reference.md" "src/published/contract/fixtures/invalid/body-runtime-reference.md: body: linea 5 referencia un runtime, CLI, cache, directorio o metadata propia de runtime"
check_invalid "missing-guard.md" "body: falta {{mefisto:assert-consumer-repo}}"
check_invalid "unknown-directive.md" "directiva mefisto desconocida"
check_invalid_exact "malformed-directive.md" "src/published/contract/fixtures/invalid/malformed-directive.md: body: linea 5 directiva mefisto mal formada: {{mefisto:launch-agent invalid:id}}"
check_invalid "malformed-mcp.md" "mcp.0"
check_invalid "unknown-mcp.md" "mcp.0: valor"
check_invalid "missing-skill.md" "skills: 'skill-inexistente' no resuelve"
check_invalid "prefixed-skill.md" "skills.0: 'mefisto-projections' no coincide"
check_invalid "prefixed-agent-reference.md" "agent: 'mefisto-example-agent' no coincide"
check_invalid_exact "runtime-variable.md" 'src/published/contract/fixtures/invalid/runtime-variable.md: body: linea 5 referencia un runtime, CLI, cache, directorio o metadata propia de runtime
src/published/contract/fixtures/invalid/runtime-variable.md: body: linea 5 placeholder no permitido: $CLAUDE_PLUGIN_ROOT (solo se admite $ARGUMENTS)'
check_invalid "guard-outside-body.md" "body: falta {{mefisto:assert-consumer-repo}}"
check_invalid_exact "partially-malformed-directive.md" "src/published/contract/fixtures/invalid/partially-malformed-directive.md: body: linea 4 directiva mefisto mal formada"
check_invalid "launch-agent-no-message.md" "directiva mefisto mal formada: {{mefisto:launch-agent bug-investigator}}"
check_invalid "launch-agent-unknown-agent.md" "launch-agent 'agente-inexistente' no existe en src/published/agents"
check_invalid "launch-agent-with-agent.md" "un comando con agent no puede usar launch-agent"
check_invalid "extra-closing-brace.md" "directiva mefisto mal formada"
check_invalid "prefixed-directive-id.md" "directiva mefisto mal formada"
check_invalid "skill-root-invalid-id.md" "directiva mefisto mal formada: {{mefisto:skill-root mefisto-projections}}"
check_invalid "skill-root-undeclared.md" "directiva skill-root comment-cleanup no esta declarada en skills"
check_invalid "command-doc-missing.md" "directiva command-doc command-doc-inexistente no resuelve a src/published/commands/command-doc-inexistente.md"
check_invalid "command-doc-invalid-id.md" "directiva mefisto mal formada: {{mefisto:command-doc Mefisto-Draft}}"
check_invalid "command-doc-self.md" "directiva command-doc command-doc-self referencia al propio comando"
check_invalid "skill-root-missing.md" "directiva skill-root skill-inexistente no resuelve a skills/skill-inexistente/SKILL.md"

skill_root_source="$(< "$CONTRACT_DIR/fixtures/valid/skill-root.md")"
if printf '%s' "$skill_root_source" | grep -Eq 'Claude|mefisto-projections|MEFISTO_PACKAGE_ROOT|\.claude'; then
    fail "skill-root.md acopla la fuente neutral a un runtime"
else
    pass "skill-root.md conserva exclusivamente el id logico"
fi

echo "[no-args] fuentes publicadas"
out=$(bash "$VALIDATOR" 2>&1); rc=$?; [ "$rc" -eq 0 ] && pass "todas las fuentes publicadas validan" || fail "sin argumentos: $out"

echo "[mcp] registro neutral y proyeccion Claude"
out=$(bash "$MCP_VALIDATOR" 2>&1); rc=$?; [ "$rc" -eq 0 ] && pass "registro MCP publicado valida" || fail "registro MCP: $out"
out=$(bash "$MCP_VALIDATOR" --registry "$MCP_FIXTURES/valid/mcp-servers.json" 2>&1); rc=$?; [ "$rc" -eq 0 ] && pass "fixture MCP válido" || fail "fixture MCP válido: $out"
check_invalid_mcp() {
    local name="$1" expected="$2" out rc
    out=$(bash "$MCP_VALIDATOR" --registry "$MCP_FIXTURES/invalid/$name" 2>&1); rc=$?
    if [ "$rc" -eq 0 ]; then fail "MCP $name fue aceptado"
    elif printf '%s' "$out" | grep -qF -- "$expected"; then pass "MCP $name: $expected"
    else fail "MCP $name fue rechazado por otro motivo: $out"
    fi
}
check_invalid_mcp "bundled-without-url.json" "bundled exige"
check_invalid_mcp "bundled-without-authentication.json" "bundled exige"
check_invalid_mcp "external-with-connection.json" "external exige"
check_invalid_mcp "sensitive-key.json" "headers: propiedad adicional"
check_invalid_mcp "duplicate-id.json" "ids duplicados"
check_invalid_mcp "out-of-order-ids.json" "ids fuera de orden"
check_invalid_mcp "empty-servers.json" "cantidad minima de elementos"
check_invalid_mcp "non-kebab-id.json" "id: 'Microsoft_Learn' no coincide"
out=$(bash "$MCP_VALIDATOR" --artifact-schema "$MCP_FIXTURES/invalid/artifact-schema-divergent.json" 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qF "enum mcp para agent difiere en orden"; then pass "MCP detecta orden divergente"; else fail "MCP no detectó orden divergente: $out"; fi
out=$(bash "$MCP_VALIDATOR" --artifact-schema "$MCP_FIXTURES/invalid/artifact-schema-duplicate-enum.json" 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qF "enum mcp para agent contiene ids duplicados"; then pass "MCP detecta enum duplicado"; else fail "MCP no detectó enum duplicado: $out"; fi
out=$(bash "$MCP_VALIDATOR" --artifact-schema "$MCP_FIXTURES/invalid/artifact-schema-unknown-id.json" 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qF "enum mcp para agent contiene id desconocido: servidor-ajeno"; then pass "MCP detecta id desconocido"; else fail "MCP no detectó id desconocido: $out"; fi
out=$(bash "$MCP_VALIDATOR" --artifact-schema "$MCP_FIXTURES/invalid/artifact-schema-missing-id.json" 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qF "enum mcp para agent omite id del registro: terraform"; then pass "MCP detecta diferencia de ids"; else fail "MCP no detectó diferencia de ids: $out"; fi
out=$(bash "$MCP_VALIDATOR" --claude-config "$MCP_FIXTURES/invalid/claude-config-divergent.json" 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qF "difiere de la proyeccion Claude"; then pass "MCP detecta .mcp.json divergente"; else fail "MCP no detectó .mcp.json divergente: $out"; fi
out=$(bash "$MCP_VALIDATOR" --claude-config "$MCP_FIXTURES/valid/claude-config-reordered.json" 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then pass "MCP compara estructura y no orden de claves JSON"; else fail "MCP rechazó una proyección estructuralmente idéntica: $out"; fi
echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
[ "$FAIL" -eq 0 ]
