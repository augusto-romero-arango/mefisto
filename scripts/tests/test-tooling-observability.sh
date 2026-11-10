#!/usr/bin/env bash
# Regresion focalizada de #1063: derivacion segura, correlacion e identidad.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
FIXTURES="$ROOT/scripts/tests/fixtures/tooling-observability"
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
# shellcheck source=/dev/null
source "$ROOT/scripts/_pipeline-common.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

derive_stage_log_from_stream "$FIXTURES/success.events.jsonl" "" "$TMP/success.log"
if grep -Fxq '[tool] Edit' "$TMP/success.log" && grep -Fxq success "$TMP/success.log"; then pass 'log legible deriva solo eventos neutrales'; else fail 'log legible incompleto'; fi

derive_stage_log_from_stream "$FIXTURES/truncated-input.events.jsonl" "" "$TMP/truncated.log"
if ! grep -Fq CENTINELA "$TMP/truncated.log" && grep -Fxq '[tool] write' "$TMP/truncated.log"; then pass 'stream neutral truncado no cae a parser legacy ni persiste inputs'; else fail 'stream truncado filtro un input sensible'; fi

BASE="$(compute_stage_metrics "$FIXTURES/hold.events.jsonl")"
METRICS="$(enrich_tooling_stage_metrics "$FIXTURES/hold.events.jsonl" "$BASE" 1063 null 2 tooling-reviewer deep '{"harness_version":null,"harness_commit":null,"identity_state":"metadata_missing"}')"
if printf '%s' "$METRICS" | jq -e '.pipeline == "tooling" and .issue == "1063" and .stage == "2" and .runtime == "fake" and .profile == "deep" and .requested_model == null and .effective_model == "openai/gpt-5" and .inherited == true and .session_id == "ses-hold" and .result == "failed" and .error_kind == "rate_limit" and .identity_state == "metadata_missing"' >/dev/null; then pass 'fallo hold conserva correlacion y degradacion'; else fail "metricas hold incompletas: $METRICS"; fi

mkdir -p "$TMP/package/scripts"
cp "$ROOT/scripts/_pipeline-common.sh" "$TMP/package/scripts/_pipeline-common.sh"
printf '%s\n' '{"schemaVersion":1,"runtime":"claude","version":"1.2.3","commit":"0123456789abcdef0123456789abcdef01234567"}' > "$TMP/package/mefisto-manifest.json"
IDENTITY="$(bash -c 'source "$1"; get_harness_identity_json "$2"' _ "$TMP/package/scripts/_pipeline-common.sh" claude)"
if printf '%s' "$IDENTITY" | jq -e '.harness_version == "1.2.3" and .harness_commit == "0123456789abcdef0123456789abcdef01234567" and .identity_state == "complete"' >/dev/null; then pass 'identidad completa viene del manifiesto distribuido'; else fail "identidad completa invalida: $IDENTITY"; fi
MISMATCH="$(bash -c 'source "$1"; get_harness_identity_json "$2"' _ "$TMP/package/scripts/_pipeline-common.sh" fake)"
if printf '%s' "$MISMATCH" | jq -e '.harness_version == null and .harness_commit == null and .identity_state == "metadata_invalid"' >/dev/null; then pass 'runtime divergente degrada a null sin inferencias'; else fail "identidad divergente no degrado: $MISMATCH"; fi

printf '\nResultado: %s PASS, %s FAIL\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
