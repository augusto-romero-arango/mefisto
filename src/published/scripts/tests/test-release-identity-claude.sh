#!/usr/bin/env bash
# Identidad Claude: fuente neutral cerrada y asset suplementario, Bash 3.2 + jq.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-published-adapters.sh"
ADAPTER_SOURCE="$REPO_ROOT/src/published/scripts/adapters/adapter-claude.sh"
LIB_SOURCE="$REPO_ROOT/src/published/scripts/lib/adapter-claude.sh"
EFFECTIVE_CONTRACT_SOURCE="$REPO_ROOT/src/published/scripts/lib/effective-contract.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
file_mode() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }
assert_failure() {
    local label="$1" output rc
    output="$(bash "$ADAPTER" render-asset mefisto-manifest "$FAKE/src/published/release-identity.json" 2>&1)"; rc=$?
    [ "$rc" -ne 0 ] && [ -n "$output" ] && pass "$label" || fail "$label"
}
setup_fake() {
    FAKE="$WORK/repo con espacios"
    ADAPTER="$FAKE/src/published/scripts/adapters/adapter-claude.sh"
    mkdir -p "$FAKE/src/published/scripts/adapters" "$FAKE/src/published/scripts/lib" "$FAKE/src/published" "$FAKE/.claude-plugin"
    cp "$ADAPTER_SOURCE" "$FAKE/src/published/scripts/adapters/"
    cp "$LIB_SOURCE" "$EFFECTIVE_CONTRACT_SOURCE" "$FAKE/src/published/scripts/lib/"
    chmod 0755 "$ADAPTER"
    printf '%s\n' '{"name":"mefisto","version":"1.2.3"}' > "$FAKE/.claude-plugin/plugin.json"
    printf '%s\n' '{"schemaVersion":1,"version":"1.2.3","commit":"0123456789abcdef0123456789abcdef01234567"}' > "$FAKE/src/published/release-identity.json"
}

printf '[pre] sintaxis y bootstrap\n'
bash -n "$ADAPTER_SOURCE" && jq -e --arg v "$(jq -r .version "$REPO_ROOT/.claude-plugin/plugin.json")" '(keys | sort) == ["commit", "schemaVersion", "version"] and .schemaVersion == 1 and .version == $v and (.version | test("^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$")) and (.commit | test("^[0-9a-f]{40}$"))' "$REPO_ROOT/src/published/release-identity.json" >/dev/null && pass 'bootstrap cerrado coincide con la identidad vigente' || fail 'bootstrap invalido'

setup_fake
assets="$(bash "$ADAPTER" assets)"; rc=$?
[ "$rc" -eq 0 ] && [ "$assets" = '[{"id":"mefisto-manifest","source":"src/published/release-identity.json","destination":"mefisto-manifest.json","mode":"0644"}]' ] && pass 'Claude declara el asset suplementario exacto' || fail 'declaracion de asset invalida'
manifest="$(bash "$ADAPTER" render-asset mefisto-manifest "$FAKE/src/published/release-identity.json")"; rc=$?
[ "$rc" -eq 0 ] && [ "$manifest" = '{"schemaVersion":1,"runtime":"claude","version":"1.2.3","commit":"0123456789abcdef0123456789abcdef01234567"}' ] && pass 'render snapshot del manifiesto Claude' || fail 'snapshot del manifiesto invalido'

cp "$FAKE/src/published/release-identity.json" "$FAKE/identidad alternativa.json"
printf '%s\n' '{"schemaVersion":1,"version":"rota","commit":"0123456789abcdef0123456789abcdef01234567"}' > "$FAKE/src/published/release-identity.json"
manifest="$(bash "$ADAPTER" render-asset mefisto-manifest "$FAKE/identidad alternativa.json")"; rc=$?
[ "$rc" -eq 0 ] && [ "$manifest" = '{"schemaVersion":1,"runtime":"claude","version":"1.2.3","commit":"0123456789abcdef0123456789abcdef01234567"}' ] && pass 'render-asset consume la fuente recibida por la interfaz' || fail 'render-asset ignoro su fuente'

printf '%s\n' '{"schemaVersion":1,"version":"version-invalida","commit":"0123456789abcdef0123456789abcdef01234567"}' > "$FAKE/src/published/release-identity.json"; assert_failure 'SemVer invalido aborta'
printf '%s\n' '{"schemaVersion":1,"version":"1.2.3-01","commit":"0123456789abcdef0123456789abcdef01234567"}' > "$FAKE/src/published/release-identity.json"; assert_failure 'identificador numerico SemVer con cero inicial aborta'
printf '%s\n' '{"schemaVersion":1,"version":"1.2.3","commit":"corto"}' > "$FAKE/src/published/release-identity.json"; assert_failure 'SHA invalido aborta'
printf '%s\n' '{"schemaVersion":2,"version":"1.2.3","commit":"0123456789abcdef0123456789abcdef01234567"}' > "$FAKE/src/published/release-identity.json"; assert_failure 'schemaVersion invalido aborta'
printf '%s\n' '{"schemaVersion":1,"version":"1.2.3"}' > "$FAKE/src/published/release-identity.json"; assert_failure 'campo obligatorio ausente aborta'
printf '%s\n' '{"schemaVersion":1,"version":"1.2.3","commit":"0123456789abcdef0123456789abcdef01234567","extra":true}' > "$FAKE/src/published/release-identity.json"; assert_failure 'campo extra aborta'
printf '%s\n' '{"schemaVersion":1,"version":"2.0.0","commit":"0123456789abcdef0123456789abcdef01234567"}' > "$FAKE/src/published/release-identity.json"; assert_failure 'version divergente de plugin aborta'
rm "$FAKE/src/published/release-identity.json"; assert_failure 'fuente ausente aborta'

printf '[integracion] staging e inventario\n'
OUT="$WORK/salida Claude con espacios"
source_before="$(shasum "$REPO_ROOT/src/published/release-identity.json")"
bash "$GENERATOR" --out "$OUT" "$REPO_ROOT/src/published/agents/tooling-reviewer.md"; rc=$?
expected="$(jq -c '{schemaVersion, runtime:"claude", version, commit}' "$REPO_ROOT/src/published/release-identity.json")"
[ "$rc" -eq 0 ] && jq -e --argjson e "$expected" '. == $e' "$OUT/dist/claude/mefisto-manifest.json" >/dev/null && pass 'generador renderiza manifiesto desde identidad neutral' || fail 'generador no renderizo manifiesto'
[ "$(file_mode "$OUT/dist/claude/mefisto-manifest.json")" = 644 ] && pass 'manifiesto tiene modo 0644' || fail 'modo del manifiesto invalido'
jq -e '.assets[] | select(.adapter == "adapter-claude.sh" and .id == "mefisto-manifest" and .source == "src/published/release-identity.json" and .destination == "mefisto-manifest.json" and .mode == "0644")' "$OUT/dist/claude/.mefisto-generated-assets.json" >/dev/null && pass 'inventario atribuye el manifiesto a su fuente' || fail 'inventario no atribuye manifiesto'
bash "$GENERATOR" --check --out "$OUT" "$REPO_ROOT/src/published/agents/tooling-reviewer.md" >/dev/null; rc=$?
[ "$rc" -eq 0 ] && pass '--check acepta contenido, modo e inventario al dia' || fail '--check rechazo salida al dia'
first="$(shasum "$OUT/dist/claude/mefisto-manifest.json" "$OUT/dist/claude/.mefisto-generated-assets.json")"
bash "$GENERATOR" --out "$OUT" "$REPO_ROOT/src/published/agents/tooling-reviewer.md" >/dev/null
second="$(shasum "$OUT/dist/claude/mefisto-manifest.json" "$OUT/dist/claude/.mefisto-generated-assets.json")"
[ "$first" = "$second" ] && [ "$source_before" = "$(shasum "$REPO_ROOT/src/published/release-identity.json")" ] && pass 'generacion repetida es determinista y no modifica la fuente' || fail 'generacion no determinista o fuente modificada'
chmod 0600 "$OUT/dist/claude/mefisto-manifest.json"
check="$(bash "$GENERATOR" --check --out "$OUT" "$REPO_ROOT/src/published/agents/tooling-reviewer.md")"; rc=$?
[ "$rc" -eq 1 ] && case "$check" in *'dist/claude/mefisto-manifest.json: modo divergente'*) true ;; *) false ;; esac && pass '--check detecta modo divergente del manifiesto' || fail '--check no detecto modo divergente del manifiesto'
bash "$GENERATOR" --out "$OUT" "$REPO_ROOT/src/published/agents/tooling-reviewer.md" >/dev/null
jq '.assets = []' "$OUT/dist/claude/.mefisto-generated-assets.json" > "$WORK/inventario-corrupto.json"
mv "$WORK/inventario-corrupto.json" "$OUT/dist/claude/.mefisto-generated-assets.json"
check="$(bash "$GENERATOR" --check --out "$OUT" "$REPO_ROOT/src/published/agents/tooling-reviewer.md")"; rc=$?
[ "$rc" -eq 1 ] && case "$check" in *'dist/claude/.mefisto-generated-assets.json: inventario inconsistente'*) true ;; *) false ;; esac && pass '--check detecta inventario del manifiesto divergente' || fail '--check no detecto inventario divergente'
bash "$GENERATOR" --out "$OUT" "$REPO_ROOT/src/published/agents/tooling-reviewer.md" >/dev/null
printf 'corrupto\n' > "$OUT/dist/claude/mefisto-manifest.json"
check="$(bash "$GENERATOR" --check --out "$OUT" "$REPO_ROOT/src/published/agents/tooling-reviewer.md")"; rc=$?
[ "$rc" -eq 1 ] && case "$check" in *'dist/claude/mefisto-manifest.json: distinta'*) true ;; *) false ;; esac && pass '--check detecta manifiesto divergente sin marcador JSON' || fail '--check no detecto manifiesto divergente'
bash "$GENERATOR" --out "$OUT" "$REPO_ROOT/src/published/agents/tooling-reviewer.md" >/dev/null
rm "$OUT/dist/claude/mefisto-manifest.json"
check="$(bash "$GENERATOR" --check --out "$OUT" "$REPO_ROOT/src/published/agents/tooling-reviewer.md")"; rc=$?
[ "$rc" -eq 1 ] && case "$check" in *'dist/claude/mefisto-manifest.json: faltante'*) true ;; *) false ;; esac && pass '--check detecta manifiesto faltante' || fail '--check no detecto manifiesto faltante'

printf '\nResultado: %s PASS, %s FAIL\n' "$PASS" "$FAIL"
exit "$FAIL"
