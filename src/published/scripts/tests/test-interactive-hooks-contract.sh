#!/usr/bin/env bash
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
HOOKS="$REPO_ROOT/src/published/hooks"
VALIDATOR="$REPO_ROOT/src/published/scripts/validate-interactive-hooks.sh"
FIXTURES="$HOOKS/fixtures"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "[pre] contrato y schema"
for file in "$HOOKS/interactive-hooks.json" "$HOOKS/interactive-hooks.schema.json" "$VALIDATOR"; do [ -f "$file" ] && pass "existe ${file#"$REPO_ROOT"/}" || fail "falta ${file#"$REPO_ROOT"/}"; done
jq empty "$HOOKS/interactive-hooks.schema.json" >/dev/null 2>&1 && pass "schema JSON valido" || fail "schema JSON invalido"
bash -n "$VALIDATOR" && pass "validador Bash valido" || fail "validador Bash invalido"

echo "[valid] descriptor y fixture"
out=$(bash "$VALIDATOR" "$HOOKS/interactive-hooks.json" 2>&1); [ $? -eq 0 ] && pass "descriptor vigente" || fail "descriptor vigente: $out"
out=$(bash "$VALIDATOR" "$FIXTURES/valid/interactive-hooks.json" 2>&1); [ $? -eq 0 ] && pass "fixture valido" || fail "fixture valido: $out"

expected_error() {
    case "$1" in
        action-without-contract.jq) echo "accion sin contrato" ;;
        additional-persisted-field.jq) echo "allowlist de campos persistibles divergente" ;;
        delivery-divergent.jq) echo "delivery divergente" ;;
        duplicate-destination.jq) echo "destinos duplicados" ;;
        duplicate-id.jq) echo "id duplicado" ;;
        extra-property.jq) echo "propiedad adicional o faltante" ;;
        legacy-destination-on-other-binding.jq) echo "destinos no coinciden con su contrato" ;;
        missing-canonical-destination.jq) echo "falta el destino canonico obligatorio" ;;
        runtime-reference.jq) echo "referencia a runtime" ;;
        sensitive-field.jq) echo "campo persistible sensible" ;;
        unknown-action.jq) echo "accion desconocida" ;;
        unknown-destination.jq) echo "destino desconocido" ;;
        unknown-field.jq) echo "allowlist de campos persistibles divergente" ;;
        unknown-pair.jq) echo "par signal/action desconocido" ;;
        unknown-signal.jq) echo "signal desconocida" ;;
        *) echo "fixture sin expectativa" ;;
    esac
}

for fixture in "$FIXTURES"/invalid/*.jq; do
    candidate="$WORK/$(basename "$fixture" .jq).json"
    jq -f "$fixture" "$FIXTURES/valid/interactive-hooks.json" > "$candidate"
    out=$(bash "$VALIDATOR" "$candidate" 2>&1)
    rc=$?
    expected=$(expected_error "$(basename "$fixture")")
    if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qF "$expected"; then
        pass "$(basename "$fixture"): $expected"
    elif [ "$rc" -eq 0 ]; then
        fail "$(basename "$fixture") fue aceptado"
    else
        fail "$(basename "$fixture") fue rechazado por otro motivo: $out"
    fi
done

echo "[legacy-release-marker] reservado a record-active-release"
for index in 1 2 3 4 5 6; do
    candidate="$WORK/legacy-release-marker-$index.json"
    jq ".bindings[$index].destinations += [\"legacy-release-marker\"]" "$FIXTURES/valid/interactive-hooks.json" > "$candidate"
    out=$(bash "$VALIDATOR" "$candidate" 2>&1)
    rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qF "destinos no coinciden con su contrato"; then
        pass "binding $index rechaza legacy-release-marker"
    elif [ "$rc" -eq 0 ]; then
        fail "binding $index acepto legacy-release-marker"
    else
        fail "binding $index rechazo legacy-release-marker por otro motivo: $out"
    fi
done

echo "[sessions.jsonl] fixtures de compatibilidad y append-only"
SESSION_FIXTURES="$FIXTURES/sessions"
started_keys='["cwd","harness_commit","harness_version","model","record_type","runtime","session_id","source","timestamp","transcript_path"]'
observed_keys='["harness_commit","harness_version","model","record_type","runtime","session_id","timestamp"]'
legacy_keys='["cwd","harness_version","session_id","source","timestamp","transcript_path"]'
for fixture in "$SESSION_FIXTURES"/*.jsonl; do
    if jq -e --argjson started_keys "$started_keys" --argjson observed_keys "$observed_keys" --argjson legacy_keys "$legacy_keys" '
        def non_empty_string: type == "string" and length > 0;
        def timestamp: type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");
        def runtime: . == "claude";
        def version: . == null or non_empty_string;
        def commit: . == null or (type == "string" and test("^[0-9a-f]{40}$"));
        if has("record_type") | not then
            keys == $legacy_keys and (.session_id | non_empty_string) and
            (.transcript_path | non_empty_string) and (.cwd | non_empty_string) and
            (.source | non_empty_string) and (.timestamp | timestamp) and
            (.harness_version | version)
        elif .record_type == "session.started" then
            keys == $started_keys and (.session_id | non_empty_string) and
            (.transcript_path | non_empty_string) and (.cwd | non_empty_string) and
            (.source | non_empty_string) and (.timestamp | timestamp) and
            (.runtime | runtime) and (.model == null or (.model | non_empty_string)) and
            (.harness_version | version) and (.harness_commit | commit)
        elif .record_type == "session.model-observed" then
            keys == $observed_keys and (.session_id | non_empty_string) and
            (.timestamp | timestamp) and (.runtime | runtime) and
            (.model | non_empty_string) and (.harness_version | version) and
            (.harness_commit | commit)
        else false end
    ' "$fixture" >/dev/null 2>&1; then
        pass "$(basename "$fixture"): todas las lineas cumplen el contrato aplicable"
    else
        fail "$(basename "$fixture"): linea JSONL invalida o fuera de contrato"
    fi
done

if jq -e '.record_type == "session.started" and .model != null and .harness_version != null and .harness_commit != null' "$SESSION_FIXTURES/started-complete.jsonl" >/dev/null 2>&1 &&
   jq -e '.record_type == "session.started" and .model == null' "$SESSION_FIXTURES/started-null-model.jsonl" >/dev/null 2>&1 &&
   jq -e '.record_type == "session.started" and .harness_version == null and .harness_commit == null' "$SESSION_FIXTURES/missing-manifest.jsonl" >/dev/null 2>&1; then
    pass "inicios: identidad completa, modelo nulo y manifiesto ausente quedan diferenciados"
else
    fail "inicios: falta un caso de identidad completa o degradada"
fi
if jq -e '.record_type == "session.model-observed" and (.model | type == "string" and length > 0) and (has("provider") | not)' "$SESSION_FIXTURES/first-model-observation.jsonl" >/dev/null 2>&1; then
    pass "first-model-observation.jsonl: la observacion conserva un modelo opaco sin campo provider"
else
    fail "first-model-observation.jsonl: observacion de modelo invalida"
fi
if jq -s 'length == 3 and [.[].record_type] == ["session.started", "session.model-observed", "session.model-observed"] and [.[].model] == [null, "claude-sonnet-4-6", "claude-opus-4-6"] and ([.[] | select(.model != null) | .model] | unique | length) == 2' "$SESSION_FIXTURES/model-repeat-and-change.jsonl" >/dev/null 2>&1; then
    pass "model-repeat-and-change.jsonl: A repetido se omite y A->B conserva ambos hechos"
else
    fail "model-repeat-and-change.jsonl: semantica append-only invalida"
fi
if jq -s --argjson legacy_keys "$legacy_keys" 'length == 2 and (.[0] | keys) == $legacy_keys and (.[0] | has("record_type") | not) and .[1].record_type == "session.started"' "$SESSION_FIXTURES/legacy-and-new.jsonl" >/dev/null 2>&1; then
    pass "legacy-and-new.jsonl: seis campos se interpretan como inicio legacy sin migracion"
else
    fail "legacy-and-new.jsonl: compatibilidad historica invalida"
fi

echo "[remind-field-notes] destino del recordatorio"
claude_reminder="$(grep -o '\[recordatorio\][^'"'"']*' "$REPO_ROOT/scripts/interactive-hooks.mts" | head -n 1)"
if [ -n "$claude_reminder" ] && printf '%s' "$claude_reminder" | grep -qF 'docs/bitacora/field-notes/'; then
    pass "el recordatorio apunta a docs/bitacora/field-notes/"
else
    fail "el recordatorio no apunta a docs/bitacora/field-notes/: '$claude_reminder'"
fi

echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
[ "$FAIL" -eq 0 ]
