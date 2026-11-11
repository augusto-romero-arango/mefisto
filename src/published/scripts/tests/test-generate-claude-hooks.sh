#!/usr/bin/env bash
# Pruebas de generacion del adaptador Claude. El comportamiento de cada binding lo cubre
# scripts/tests/interactive-hooks.test.mts.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
GENERATOR="$REPO_ROOT/src/published/scripts/generate-claude-hooks.sh"
HOOKS="$REPO_ROOT/hooks/hooks.json"
FIXTURES="$HERE/fixtures/claude-hooks"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq no instalado"; exit 0; }
echo "[generacion] salida determinista y topologia Claude"
bash -n "$GENERATOR" && pass "generador Bash valido" || fail "generador Bash invalido"
bash "$GENERATOR" --check >/dev/null && pass "--check acepta la salida vigente" || fail "--check rechazo la salida vigente"
out=$(bash "$GENERATOR" --check --out "$TMP/vacio" 2>&1); [ $? -ne 0 ] && [ "$out" = "hooks/hooks.json: faltante" ] && pass "--check informa salida faltante sin escribir" || fail "--check faltante: $out"
mkdir -p "$TMP/render" && bash "$GENERATOR" --out "$TMP/render" && cmp -s "$HOOKS" "$TMP/render/hooks/hooks.json" && pass "render alternativo coincide byte a byte" || fail "render alternativo divergente"
printf '%s\n' '{"distinta":true}' > "$TMP/render/hooks/hooks.json"
out=$(bash "$GENERATOR" --check --out "$TMP/render" 2>&1); [ $? -ne 0 ] && [ "$out" = "hooks/hooks.json: distinta" ] && [ "$(jq -r '.distinta' "$TMP/render/hooks/hooks.json")" = true ] && pass "--check informa diferencia sin escribir" || fail "--check distinta: $out"
jq -e '(. | keys) == ["hooks","modules"] and .modules == ["./index.tsx"] and (.hooks | keys | sort) == ["PostToolUse","SessionStart","Stop"] and (.hooks.SessionStart | length) == 1 and (.hooks.SessionStart[0] | keys) == ["hooks"] and ([.hooks.SessionStart[0].hooks[]] | length) == 2 and (.hooks.Stop | length) == 1 and ([.hooks.Stop[0].hooks[]] | length) == 2 and ([.hooks.PostToolUse[].matcher] == ["Write|Edit", "Bash"]) and ([.hooks.PostToolUse[] | .hooks[]] | length) == 3 and ([.hooks.SessionStart[0].hooks[], .hooks.Stop[0].hooks[], .hooks.PostToolUse[].hooks[]] | all(keys == ["args","command","type"] and .type == "command" and .command == "node" and (.args | length) == 2 and (has("async") | not) and (has("timeout") | not) and (has("shell") | not)))' "$HOOKS" >/dev/null && pass "estructura completa en forma exec, sync implicito y timeout omitido" || fail "topologia Claude invalida"
mkdir -p "$TMP/sinmod/hooks" && jq 'del(.modules)' "$HOOKS" > "$TMP/sinmod/hooks/hooks.json"
out=$(bash "$GENERATOR" --check --out "$TMP/sinmod" 2>&1); [ $? -ne 0 ] && [ "$out" = "hooks/hooks.json: distinta" ] && pass "--check falla si el archivo no trae modules" || fail "--check sin modules: $out"
MUT="$TMP/mutado"; mkdir -p "$MUT/src/published/scripts" "$MUT/out"
cp -R "$REPO_ROOT/src/published/hooks" "$MUT/src/published/hooks" && cp -p "$REPO_ROOT/src/published/scripts/validate-interactive-hooks.sh" "$MUT/src/published/scripts/"
sed 's|modules: \["./index.tsx"\]}|modules: ["./index.tsx"], extra: 1}|' "$GENERATOR" > "$MUT/src/published/scripts/generate-claude-hooks.sh"
grep -q 'extra: 1}' "$MUT/src/published/scripts/generate-claude-hooks.sh" && out=$(bash "$MUT/src/published/scripts/generate-claude-hooks.sh" --out "$MUT/out" 2>&1); [ $? -ne 0 ] && [ "$out" = "ERROR: el adaptador Claude renderizado no cumple la estructura de hooks" ] && [ ! -e "$MUT/out/hooks/hooks.json" ] && pass "topologia rechaza una clave de primer nivel desconocida sin escribir" || fail "topologia con clave desconocida: $out"

echo "[forma exec] un solo script y los siete bindings del contrato"
SCRIPT_ARG='${CLAUDE_PLUGIN_ROOT}/scripts/interactive-hooks.mts'
[ "$(jq -r '[.. | objects | select(has("args")) | .args[0]] | unique | join(" ")' "$HOOKS")" = "$SCRIPT_ARG" ] && pass "todos los hooks invocan el mismo script bajo la raiz de la distribucion" || fail "algun hook invoca otro script"
[ -f "$REPO_ROOT/scripts/interactive-hooks.mts" ] && pass "el script de los hooks existe" || fail "falta scripts/interactive-hooks.mts"
[ "$(jq -r '[.. | objects | select(has("args")) | .args[1]] | sort | join(" ")' "$HOOKS")" = "$(jq -r '[.bindings[].id] | sort | join(" ")' "$REPO_ROOT/src/published/hooks/interactive-hooks.json")" ] && pass "cada binding del contrato tiene su hook" || fail "los bindings de hooks.json no coinciden con el contrato"
echo "RESULTADO: $PASS pasaron, $FAIL fallaron"
[ "$FAIL" -eq 0 ]
